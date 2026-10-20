import { useEffect, useState } from 'preact/hooks';
import { del, get, patch, post, put } from '../api.js';
import { Icon } from '../components/Icon.jsx';
import { AddRow, Check, InlineEdit, LoadError, Loading, MoveButtons, PageHeader, Progress, moved } from '../components/ui.jsx';
import { PlanTabs } from '../components/PlanTabs.jsx';
import { attempt, go, useLoad } from '../hooks.js';
import { toast } from '../toast.js';
import { ProjectCard } from './Today.jsx';

const lines = (text) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

function NewProject({ templates }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [steps, setSteps] = useState('');

  if (!open) {
    return (
      <button type="button" class="btn btn-primary" onClick={() => setOpen(true)}>
        <Icon name="plus" size={18} /> New project
      </button>
    );
  }

  const submit = async (e) => {
    e.preventDefault();
    const body = templateId ? { title, templateId: Number(templateId) } : { title, steps: lines(steps).map((s) => ({ title: s })) };
    const project = await attempt(post('/projects', body));
    if (project) go(`/projects/${project.id}`);
  };

  return (
    <form class="card card-pad" onSubmit={submit}>
      <div class="field">
        <label for="project-title">Project</label>
        <input id="project-title" class="input" required maxLength={200} value={title} onInput={(e) => setTitle(e.currentTarget.value)} />
      </div>
      {templates.length > 0 && (
        <div class="field">
          <label for="project-template">Start from</label>
          <select id="project-template" class="select" value={templateId} onChange={(e) => setTemplateId(e.currentTarget.value)}>
            <option value="">My own steps</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                Template: {t.name} ({t.stepsTotal} steps)
              </option>
            ))}
          </select>
        </div>
      )}
      {!templateId && (
        <div class="field">
          <label for="project-steps">Steps, in order (one per line)</label>
          <textarea
            id="project-steps"
            class="textarea"
            placeholder={'Design\nBackend\nFrontend\nDeploy'}
            value={steps}
            onInput={(e) => setSteps(e.currentTarget.value)}
          />
        </div>
      )}
      <div class="btn-row">
        <button class="btn btn-primary" type="submit" disabled={!title.trim()}>
          Create project
        </button>
        <button class="btn btn-ghost" type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function ProjectList() {
  const { data, error, reload } = useLoad(() => Promise.all([get('/projects'), get('/templates')]), []);
  if (!data) return error ? <LoadError error={error} retry={reload} /> : <Loading />;

  const [{ projects }, { templates }] = data;
  const active = projects.filter((p) => !p.done);
  const finished = projects.filter((p) => p.done);

  return (
    <>
      <PageHeader title="Projects" sub="Steps open one at a time: finish one to unlock the next." />
      <PlanTabs current="projects" />

      {active.length === 0 ? (
        <div class="card empty">No active projects.</div>
      ) : (
        <div class="cards">
          {active.map((p) => (
            <ProjectCard key={p.id} project={p} />
          ))}
        </div>
      )}
      <div class="section">
        <NewProject templates={templates} />
      </div>

      {finished.length > 0 && (
        <section class="section">
          <h2 class="section-title" style={{ marginBottom: '10px' }}>
            Finished
          </h2>
          <div class="cards">
            {finished.map((p) => (
              <ProjectCard key={p.id} project={p} />
            ))}
          </div>
        </section>
      )}
    </>
  );
}

function Step({ step, number, base, isLastDone, openIndex, openCount, apply, onReorder }) {
  const [expanded, setExpanded] = useState(step.state === 'current');
  // The current step's checklist is open; when a step is finished, the next one opens instead.
  useEffect(() => setExpanded(step.state === 'current'), [step.state]);
  const done = step.state === 'done';
  const locked = step.state === 'locked';
  const stepBase = `${base}/steps/${step.id}`;

  const finish = () => {
    const left = step.itemsTotal - step.itemsDone;
    if (left > 0 && !confirm(`${left} checklist item${left > 1 ? 's are' : ' is'} not ticked. Finish the step anyway?`)) return;
    apply(post(`${stepBase}/finish`));
  };
  const remove = () => confirm(`Delete the step "${step.title}"?`) && apply(del(stepBase));

  return (
    <li class={`step is-${step.state}`}>
      <div class="row" style={{ borderBottom: 0 }}>
        <span class="step-num" aria-hidden="true">
          {done ? <Icon name="check" size={16} stroke-width={3} /> : locked ? <Icon name="lock" size={15} /> : number}
        </span>
        <div class="row-main">
          <InlineEdit value={step.title} label="step" onSave={(title) => apply(patch(stepBase, { title }))} />
          <div class="row-meta">
            {step.state === 'current' && <span class="badge badge-red">Now</span>}
            {done && <span class="badge badge-blue">Done</span>}
            {locked && <span class="badge">Locked</span>}
            {step.itemsTotal > 0 && ` ${step.itemsDone}/${step.itemsTotal} ticked`}
          </div>
        </div>
        <button
          type="button"
          class="icon-btn"
          aria-label={`${expanded ? 'Hide' : 'Show'} checklist for ${step.title}`}
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          <Icon name={expanded ? 'up' : 'down'} size={18} />
        </button>
      </div>

      {expanded && (
        <div class="step-body">
          <ul class="list sub-list">
            {step.items.map((item) => (
              <li key={item.id} class={`row${item.done ? ' is-done' : ''}`}>
                <Check
                  checked={item.done}
                  disabled={step.state !== 'current'}
                  label={`Done: ${item.title}`}
                  onChange={(v) => apply(patch(`${stepBase}/items/${item.id}`, { done: v }))}
                />
                <div class="row-main">
                  {done ? (
                    <span class="row-title">{item.title}</span>
                  ) : (
                    <InlineEdit value={item.title} label="checklist item" onSave={(title) => apply(patch(`${stepBase}/items/${item.id}`, { title }))} />
                  )}
                </div>
                {!done && (
                  <button
                    type="button"
                    class="icon-btn"
                    aria-label={`Delete ${item.title}`}
                    onClick={() => apply(del(`${stepBase}/items/${item.id}`))}
                  >
                    <Icon name="trash" size={16} />
                  </button>
                )}
              </li>
            ))}
            {step.items.length === 0 && <li class="small muted" style={{ padding: '6px 0' }}>No checklist for this step.</li>}
          </ul>
          {!done && <AddRow placeholder="Add a checklist item" onAdd={(title) => apply(post(`${stepBase}/items`, { title }))} />}
          {locked && <p class="small muted">Finish the earlier steps to unlock this one. You can still plan its checklist.</p>}
          <div class="btn-row" style={{ marginTop: '10px', alignItems: 'center' }}>
            {step.state === 'current' && (
              <button type="button" class="btn btn-primary btn-small" onClick={finish}>
                <Icon name="check" size={16} /> Finish step
              </button>
            )}
            {isLastDone && (
              <button type="button" class="btn btn-small" onClick={() => apply(post(`${stepBase}/reopen`))}>
                <Icon name="undo" size={16} /> Reopen step
              </button>
            )}
            {!done && (
              <span class="btn-row" style={{ marginLeft: 'auto', gap: 0 }}>
                <MoveButtons index={openIndex} count={openCount} label={step.title} onMove={(d) => onReorder(openIndex, d)} />
                <button type="button" class="icon-btn" aria-label={`Delete step ${step.title}`} onClick={remove}>
                  <Icon name="trash" size={18} />
                </button>
              </span>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

export function ProjectDetail({ id }) {
  const { data: project, error, reload, setData } = useLoad(() => get(`/projects/${id}`), [id]);
  if (!project) return error ? <LoadError error={error} retry={reload} /> : <Loading />;

  const base = `/projects/${project.id}`;
  const apply = async (promise) => {
    const res = await attempt(promise);
    if (res) setData(res);
    return Boolean(res);
  };
  const open = project.steps.filter((s) => s.state !== 'done');
  const lastDone = project.steps.filter((s) => s.state === 'done').at(-1);
  const reorder = (index, direction) => apply(put(`${base}/steps/order`, { stepIds: moved(open.map((s) => s.id), index, direction) }));

  const saveTemplate = async () => {
    const name = prompt('Template name', project.title)?.trim();
    if (!name) return;
    if (await attempt(post('/templates', { name, fromProjectId: project.id }))) toast(`Saved template "${name}"`);
  };
  const remove = async () => {
    if (!confirm(`Delete the project "${project.title}" and all its steps?`)) return;
    if ((await attempt(del(base))) !== undefined) go('/projects');
  };

  return (
    <>
      <a class="btn btn-ghost btn-small" href="#/projects" style={{ paddingLeft: 0 }}>
        <Icon name="left" size={16} /> Projects
      </a>
      <PageHeader
        title={<InlineEdit value={project.title} label="project title" onSave={(title) => apply(patch(base, { title }))} />}
        sub={project.done ? 'Finished' : `${project.stepsDone} of ${project.stepsTotal} steps done`}
      >
        <Progress value={project.progress} label="Project progress" />
      </PageHeader>

      <div class="card section">
        <ul class="list">
          {project.steps.map((step, i) => (
            <Step
              key={step.id}
              step={step}
              number={i + 1}
              base={base}
              isLastDone={step === lastDone}
              openIndex={open.indexOf(step)}
              openCount={open.length}
              apply={apply}
              onReorder={reorder}
            />
          ))}
          {project.steps.length === 0 && <li class="empty">No steps yet. Add them in the order you'll do them.</li>}
        </ul>
        <AddRow placeholder="Add a step" onAdd={(title) => apply(post(`${base}/steps`, { title }))} />
      </div>

      <div class="section btn-row">
        <button type="button" class="btn" onClick={saveTemplate} disabled={project.steps.length === 0}>
          <Icon name="template" size={18} /> Save as template
        </button>
        <button type="button" class="btn btn-danger" onClick={remove}>
          <Icon name="trash" size={18} /> Delete project
        </button>
      </div>
    </>
  );
}
