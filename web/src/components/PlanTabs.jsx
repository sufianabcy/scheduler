/** Day / Goals / Projects: the three parts of the Plan tab, one page each, switched here. */
export function PlanTabs({ current }) {
  const tab = (key, href, label) => (
    <a class="chip" href={href} aria-current={current === key ? 'page' : undefined}>
      {label}
    </a>
  );
  return (
    <nav class="page-tabs section" aria-label="Plan">
      {tab('plan', '#/plan', 'Day')}
      {tab('goals', '#/goals', 'Goals')}
      {tab('projects', '#/projects', 'Projects')}
    </nav>
  );
}
