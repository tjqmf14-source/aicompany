import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { CoreDatabase } from '../src/core/database.js';
import { CoreEngine } from '../src/core/engine.js';
import { CoreError } from '../src/core/domain.js';
import { schemaVersion } from '../src/core/migrations.js';
import { DashboardService } from '../src/dashboard/service.js';
import { OrganizationService } from '../src/organization/service.js';
import { ORGANIZATION_ROLES } from '../src/organization/types.js';
import { createApp } from '../src/server/app.js';
import { committedFixture } from './helpers.js';

function setup() {
  const work = committedFixture();
  const path = join(work.path, 'state.sqlite');
  const engine = new CoreEngine(path);
  const project = engine.createProject('Phase 5', work.path);
  const organization = new OrganizationService(engine);
  return { work, path, engine, project, organization };
}

function planInput(provider: 'GPT_HIGH' | 'CODEX' | 'SYSTEM' = 'SYSTEM') {
  return {
    objective: 'Ship Phase 5 safely',
    tasks: [
      { key: 'plan', title: 'Plan work', role: 'Planning', provider: 'GPT_HIGH', priority: 10 },
      { key: 'build', title: 'Implement work', role: 'Coding', provider, priority: 20, dependsOn: ['plan'] },
    ],
  };
}

function passTask(engine: CoreEngine, taskId: string): void {
  const task = engine.repository.getTask(taskId);
  assert.equal(task.status, 'ready');
  const run = engine.startRun(taskId);
  engine.repository.finishRun(run.id, 'completed');
  const review = engine.repository.getTask(taskId);
  engine.repository.setTaskStatus(taskId, 'passed', review.version);
}

function singleTaskPlan(organization: OrganizationService, projectId: string) {
  return organization.createPlan(projectId, {
    objective: 'Single task pipeline',
    tasks: [{ key: 'work', title: 'Do work', role: 'Coding', provider: 'SYSTEM', priority: 1 }],
  });
}

function toValidation(ctx: ReturnType<typeof setup>) {
  const plan = singleTaskPlan(ctx.organization, ctx.project.id);
  ctx.organization.start(plan.id);
  const task = ctx.organization.stateByPlan(plan.id).tasks[0]!.task;
  passTask(ctx.engine, task.id);
  return ctx.organization.advance(plan.id);
}

function toIndependentReview(ctx: ReturnType<typeof setup>) {
  const validation = toValidation(ctx);
  ctx.organization.recordGate(validation.id, 'validation', 'PASS', 'validation passed');
  return ctx.organization.advance(validation.id);
}

function toQa(ctx: ReturnType<typeof setup>) {
  const review = toIndependentReview(ctx);
  ctx.organization.recordGate(review.id, 'independent_review', 'PASS', 'review passed');
  return ctx.organization.advance(review.id);
}

test('1. migration v5 is current schema', () => {
  const work = committedFixture();
  try {
    const db = new CoreDatabase(join(work.path, 'state.sqlite'));
    assert.equal(schemaVersion(db.db), 5);
    db.close();
  } finally { work.clean(); }
});

test('2. Organization Plan creation persists draft planning state', () => {
  const ctx = setup();
  try {
    const plan = ctx.organization.createPlan(ctx.project.id, planInput());
    assert.equal(plan.status, 'draft');
    assert.equal(plan.stage, 'planning');
    assert.equal(ctx.organization.store.get(plan.id).projectId, ctx.project.id);
  } finally { ctx.engine.close(); ctx.work.clean(); }
});

test('3. Objective persists exactly', () => {
  const ctx = setup();
  try {
    const plan = ctx.organization.createPlan(ctx.project.id, { ...planInput(), objective: 'Exact objective text' });
    assert.equal(ctx.organization.store.get(plan.id).objective, 'Exact objective text');
  } finally { ctx.engine.close(); ctx.work.clean(); }
});

test('4. Role registry contains the 12 approved logical roles', () => {
  assert.equal(ORGANIZATION_ROLES.length, 12);
  assert.ok(ORGANIZATION_ROLES.includes('Executive PD'));
  assert.ok(ORGANIZATION_ROLES.includes('Release'));
});

test('5. only actually ready roles become active', () => {
  const ctx = setup();
  try {
    const plan = ctx.organization.createPlan(ctx.project.id, planInput());
    ctx.organization.start(plan.id);
    const state = ctx.organization.stateByPlan(plan.id);
    assert.deepEqual(state.activeRoles, ['Planning']);
    assert.equal(state.currentRole, 'Planning');
  } finally { ctx.engine.close(); ctx.work.clean(); }
});

test('6. Task is assigned to its real role', () => {
  const ctx = setup();
  try {
    const plan = ctx.organization.createPlan(ctx.project.id, planInput());
    const tasks = ctx.organization.stateByPlan(plan.id).tasks;
    assert.equal(tasks[0]?.assignment.role, 'Planning');
    assert.equal(tasks[1]?.assignment.role, 'Coding');
  } finally { ctx.engine.close(); ctx.work.clean(); }
});

test('7. Task priority is persisted', () => {
  const ctx = setup();
  try {
    const plan = ctx.organization.createPlan(ctx.project.id, planInput());
    const tasks = ctx.organization.stateByPlan(plan.id).tasks;
    assert.equal(tasks[0]?.assignment.priority, 10);
    assert.equal(tasks[1]?.assignment.priority, 20);
  } finally { ctx.engine.close(); ctx.work.clean(); }
});

test('8. Task dependency is stored by real task id', () => {
  const ctx = setup();
  try {
    const plan = ctx.organization.createPlan(ctx.project.id, planInput());
    const tasks = ctx.organization.stateByPlan(plan.id).tasks;
    assert.equal(tasks[1]?.dependencies[0]?.dependsOnTaskId, tasks[0]?.task.id);
  } finally { ctx.engine.close(); ctx.work.clean(); }
});

test('9. incomplete dependency blocks downstream routing', () => {
  const ctx = setup();
  try {
    const plan = ctx.organization.createPlan(ctx.project.id, planInput());
    ctx.organization.start(plan.id);
    const child = ctx.organization.stateByPlan(plan.id).tasks[1]!.task;
    assert.equal(child.status, 'queued');
    assert.throws(() => ctx.organization.route(child.id), (error: unknown) =>
      error instanceof CoreError && error.code === 'CONFLICT');
  } finally { ctx.engine.close(); ctx.work.clean(); }
});

test('10. passing dependency activates downstream task', () => {
  const ctx = setup();
  try {
    const plan = ctx.organization.createPlan(ctx.project.id, planInput());
    ctx.organization.start(plan.id);
    const before = ctx.organization.stateByPlan(plan.id).tasks;
    passTask(ctx.engine, before[0]!.task.id);
    const state = ctx.organization.refresh(plan.id);
    assert.equal(state.tasks[1]?.task.status, 'ready');
    assert.deepEqual(state.activeRoles, ['Coding']);
  } finally { ctx.engine.close(); ctx.work.clean(); }
});

test('11. GPT_HIGH routing is returned for ready High task', () => {
  const ctx = setup();
  try {
    const plan = ctx.organization.createPlan(ctx.project.id, {
      objective: 'High task',
      tasks: [{ key: 'work', title: 'Reasoning work', role: 'Planning', provider: 'GPT_HIGH' }],
    });
    ctx.organization.start(plan.id);
    const task = ctx.organization.stateByPlan(plan.id).tasks[0]!.task;
    assert.equal(ctx.organization.route(task.id).provider, 'GPT_HIGH');
  } finally { ctx.engine.close(); ctx.work.clean(); }
});

test('12. CODEX routing is returned for ready Codex task', () => {
  const ctx = setup();
  try {
    const plan = ctx.organization.createPlan(ctx.project.id, {
      objective: 'Codex task',
      tasks: [{ key: 'work', title: 'Local implementation', role: 'Coding', provider: 'CODEX' }],
    });
    ctx.organization.start(plan.id);
    const task = ctx.organization.stateByPlan(plan.id).tasks[0]!.task;
    assert.equal(ctx.organization.route(task.id).provider, 'CODEX');
  } finally { ctx.engine.close(); ctx.work.clean(); }
});

test('13. SYSTEM routing is returned without fake completion', () => {
  const ctx = setup();
  try {
    const plan = singleTaskPlan(ctx.organization, ctx.project.id);
    ctx.organization.start(plan.id);
    const task = ctx.organization.stateByPlan(plan.id).tasks[0]!.task;
    assert.equal(ctx.organization.route(task.id).provider, 'SYSTEM');
    assert.equal(ctx.engine.repository.getTask(task.id).status, 'ready');
  } finally { ctx.engine.close(); ctx.work.clean(); }
});

test('14. Executive PD starts planning into execution', () => {
  const ctx = setup();
  try {
    const plan = singleTaskPlan(ctx.organization, ctx.project.id);
    const active = ctx.organization.advance(plan.id);
    assert.equal(active.status, 'active');
    assert.equal(active.stage, 'execution');
  } finally { ctx.engine.close(); ctx.work.clean(); }
});

test('15. validation stage is blocked until every task passes', () => {
  const ctx = setup();
  try {
    const plan = singleTaskPlan(ctx.organization, ctx.project.id);
    ctx.organization.start(plan.id);
    assert.throws(() => ctx.organization.advance(plan.id), (error: unknown) =>
      error instanceof CoreError && error.code === 'CONFLICT');
  } finally { ctx.engine.close(); ctx.work.clean(); }
});

test('16. validation PASS opens independent review', () => {
  const ctx = setup();
  try {
    const stage = toValidation(ctx);
    ctx.organization.recordGate(stage.id, 'validation', 'PASS', 'validated');
    assert.equal(ctx.organization.advance(stage.id).stage, 'independent_review');
  } finally { ctx.engine.close(); ctx.work.clean(); }
});

test('17. independent review is mandatory before QA', () => {
  const ctx = setup();
  try {
    const stage = toIndependentReview(ctx);
    assert.throws(() => ctx.organization.advance(stage.id), (error: unknown) =>
      error instanceof CoreError && error.code === 'CONFLICT');
    ctx.organization.recordGate(stage.id, 'independent_review', 'PASS', 'independent review passed');
    assert.equal(ctx.organization.advance(stage.id).stage, 'qa');
  } finally { ctx.engine.close(); ctx.work.clean(); }
});

test('18. QA PASS opens PD acceptance and creates manual approval', () => {
  const ctx = setup();
  try {
    const stage = toQa(ctx);
    ctx.organization.recordGate(stage.id, 'qa', 'PASS', 'qa passed');
    const acceptance = ctx.organization.advance(stage.id);
    assert.equal(acceptance.stage, 'pd_acceptance');
    const approval = ctx.engine.repository.listApprovals(ctx.project.id).at(-1);
    assert.equal(approval?.status, 'pending');
    assert.equal(approval?.action, `organization.pd_acceptance:${stage.id}`);
  } finally { ctx.engine.close(); ctx.work.clean(); }
});

test('19. PD acceptance cannot complete without approval', () => {
  const ctx = setup();
  try {
    const stage = toQa(ctx);
    ctx.organization.recordGate(stage.id, 'qa', 'PASS', 'qa passed');
    ctx.organization.advance(stage.id);
    ctx.organization.recordGate(stage.id, 'pd_acceptance', 'PASS', 'pd accepted');
    assert.throws(() => ctx.organization.advance(stage.id), (error: unknown) =>
      error instanceof CoreError && error.code === 'CONFLICT');
  } finally { ctx.engine.close(); ctx.work.clean(); }
});

test('20. approved PD acceptance completes plan', () => {
  const ctx = setup();
  try {
    const stage = toQa(ctx);
    ctx.organization.recordGate(stage.id, 'qa', 'PASS', 'qa passed');
    ctx.organization.advance(stage.id);
    ctx.organization.recordGate(stage.id, 'pd_acceptance', 'PASS', 'pd accepted');
    const approval = ctx.engine.repository.listApprovals(ctx.project.id).at(-1)!;
    ctx.engine.repository.resolveApproval(approval.id, 'approved');
    const done = ctx.organization.advance(stage.id);
    assert.equal(done.status, 'completed');
    assert.equal(done.stage, 'completed');
  } finally { ctx.engine.close(); ctx.work.clean(); }
});

test('21. failed validation blocks plan and rework returns to execution', () => {
  const ctx = setup();
  try {
    const stage = toValidation(ctx);
    ctx.organization.recordGate(stage.id, 'validation', 'FAIL', 'validation failed', 'test output');
    assert.equal(ctx.organization.store.get(stage.id).stage, 'blocked');
    const rework = ctx.organization.rework(stage.id);
    assert.equal(rework.stage, 'execution');
    assert.equal(rework.status, 'active');
  } finally { ctx.engine.close(); ctx.work.clean(); }
});

test('22. Organization events are real persisted events', () => {
  const ctx = setup();
  try {
    const plan = singleTaskPlan(ctx.organization, ctx.project.id);
    ctx.organization.start(plan.id);
    const types = ctx.engine.repository.listEvents(ctx.project.id).map(event => event.type);
    assert.ok(types.includes('organization.plan_created'));
    assert.ok(types.includes('organization.task_assigned'));
    assert.ok(types.includes('organization.task_ready'));
    assert.ok(types.includes('organization.role_activated'));
  } finally { ctx.engine.close(); ctx.work.clean(); }
});

test('23. Dashboard exposes actual Organization state', () => {
  const ctx = setup();
  try {
    const plan = ctx.organization.createPlan(ctx.project.id, planInput());
    ctx.organization.start(plan.id);
    const dashboard = new DashboardService(ctx.engine).projectState(ctx.project.id);
    assert.equal(dashboard.commandCenter.phase, 'execution');
    assert.equal(dashboard.commandCenter.currentRole, 'Planning');
    assert.deepEqual(dashboard.commandCenter.activeRoles, ['Planning']);
    assert.equal(dashboard.tasks.find(item => item.title === 'Plan work')?.priority, 10);
    assert.equal(dashboard.tasks.find(item => item.title === 'Implement work')?.role, 'Coding');
  } finally { ctx.engine.close(); ctx.work.clean(); }
});

test('24. Organization state survives restart', () => {
  const ctx = setup();
  const plan = ctx.organization.createPlan(ctx.project.id, planInput());
  ctx.organization.start(plan.id);
  const projectId = ctx.project.id;
  ctx.engine.close();
  try {
    const reopened = new CoreEngine(ctx.path);
    const state = new OrganizationService(reopened).state(projectId);
    assert.equal(state.plan?.id, plan.id);
    assert.equal(state.plan?.stage, 'execution');
    assert.equal(state.tasks.length, 2);
    reopened.close();
  } finally { ctx.work.clean(); }
});

test('25. invalid role, dependency cycle and paid provider are rejected', () => {
  const ctx = setup();
  try {
    assert.throws(() => ctx.organization.createPlan(ctx.project.id, {
      objective: 'bad role', tasks: [{ key: 'x', title: 'x', role: 'Fake Agent', provider: 'SYSTEM' }],
    }), (error: unknown) => error instanceof CoreError && error.code === 'INVALID_INPUT');
    assert.throws(() => ctx.organization.createPlan(ctx.project.id, {
      objective: 'cycle',
      tasks: [
        { key: 'a', title: 'a', role: 'Coding', provider: 'SYSTEM', dependsOn: ['b'] },
        { key: 'b', title: 'b', role: 'QA', provider: 'SYSTEM', dependsOn: ['a'] },
      ],
    }), (error: unknown) => error instanceof CoreError && error.code === 'INVALID_INPUT');
    assert.throws(() => ctx.organization.createPlan(ctx.project.id, {
      objective: 'paid', tasks: [{ key: 'x', title: 'x', role: 'Coding', provider: 'OPENAI_API' }],
    }), (error: unknown) => error instanceof CoreError && error.code === 'INVALID_INPUT');
  } finally { ctx.engine.close(); ctx.work.clean(); }
});

test('26. Organization API creates, starts and reads PD plan', async () => {
  const ctx = setup();
  const app = createApp(ctx.engine);
  try {
    const created = await app.inject({
      method: 'POST',
      url: `/api/organization/projects/${ctx.project.id}/plans`,
      payload: { objective: 'API plan', tasks: [{ key: 'work', title: 'API task', role: 'Coding', provider: 'SYSTEM' }] },
    });
    assert.equal(created.statusCode, 201);
    const plan = created.json() as { id: string };
    const started = await app.inject({ method: 'POST', url: `/api/organization/projects/${ctx.project.id}/plans/${plan.id}/start` });
    assert.equal(started.statusCode, 200);
    const state = await app.inject({ method: 'GET', url: `/api/organization/projects/${ctx.project.id}` });
    assert.equal(state.statusCode, 200);
    assert.equal((state.json() as { plan: { stage: string } }).plan.stage, 'execution');
  } finally {
    await app.close();
    ctx.engine.close();
    ctx.work.clean();
  }
});


test('27. unknown dependency key is rejected before persistence', () => {
  const ctx = setup();
  try {
    assert.throws(() => ctx.organization.createPlan(ctx.project.id, {
      objective: 'unknown dependency',
      tasks: [{ key: 'work', title: 'work', role: 'Coding', provider: 'SYSTEM', dependsOn: ['missing'] }],
    }), (error: unknown) => error instanceof CoreError && error.code === 'INVALID_INPUT');
    assert.equal(ctx.organization.state(ctx.project.id).plan, null);
  } finally { ctx.engine.close(); ctx.work.clean(); }
});

test('28. unassigned Core task cannot be routed as Organization work', () => {
  const ctx = setup();
  try {
    const task = ctx.engine.repository.createTask(ctx.project.id, 'Legacy task');
    ctx.engine.repository.setTaskStatus(task.id, 'ready');
    assert.throws(() => ctx.organization.route(task.id), (error: unknown) =>
      error instanceof CoreError && error.code === 'NOT_FOUND');
  } finally { ctx.engine.close(); ctx.work.clean(); }
});

test('29. GPT_HIGH dispatch reuses the real Manual Handoff path', async () => {
  const ctx = setup();
  const app = createApp(ctx.engine);
  try {
    const plan = ctx.organization.createPlan(ctx.project.id, {
      objective: 'High dispatch',
      tasks: [{ key: 'work', title: 'High reasoning', description: 'Review the implementation', role: 'Planning', provider: 'GPT_HIGH' }],
    });
    ctx.organization.start(plan.id);
    const task = ctx.organization.stateByPlan(plan.id).tasks[0]!.task;
    const response = await app.inject({
      method: 'POST',
      url: `/api/organization/projects/${ctx.project.id}/tasks/${task.id}/dispatch`,
    });
    assert.equal(response.statusCode, 200);
    const body = response.json() as { provider: string; handoff: { id: string; taskId: string | null; status: string } };
    assert.equal(body.provider, 'GPT_HIGH');
    assert.equal(body.handoff.taskId, task.id);
    assert.equal(body.handoff.status, 'awaiting_response');
  } finally {
    await app.close();
    ctx.engine.close();
    ctx.work.clean();
  }
});
