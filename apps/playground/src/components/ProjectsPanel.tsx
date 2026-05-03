import { useMemo, useState } from 'react';
import {
  ATLAS_PROJECT_PAYLOAD,
  getProjectLabel,
  PROJECT_PAYLOADS,
  type ProjectPayload,
} from '../apiTypes';
import {
  projectStore,
  renameProject,
  toggleFirstProjectTask,
} from '../stores/projectStore';

const healthLabels = {
  green: 'On track',
  yellow: 'Watch',
  red: 'Blocked',
} as const;

export function ProjectsPanel() {
  const [activePayload, setActivePayload] = useState<ProjectPayload>(
    ATLAS_PROJECT_PAYLOAD,
  );
  const [draftName, setDraftName] = useState('Atlas UI refresh');
  const projectQueries = useMemo(
    () =>
      PROJECT_PAYLOADS.map((payload) => ({
        payload,
        queryMetadata: { label: getProjectLabel(payload) },
      })),
    [],
  );
  const projects = projectStore.useMultipleItems(projectQueries, {
    returnRefetchingStatus: true,
  });
  const activeProject = projectStore.useItem(activePayload, {
    returnRefetchingStatus: true,
  });

  return (
    <section className="work-section projects-section">
      <div className="section-heading">
        <div>
          <p className="app-kicker">Delivery</p>
          <h2>Projects</h2>
        </div>
        <button
          type="button"
          onClick={() => {
            projectStore.scheduleFetch('highPriority', PROJECT_PAYLOADS);
          }}
        >
          Refresh projects
        </button>
      </div>

      <div className="project-list">
        {projects.map((project) => {
          const payload = project.payload;
          if (!payload) return null;
          const isSelected =
            getProjectLabel(payload) === getProjectLabel(activePayload);

          return (
            <button
              key={project.itemStateKey}
              type="button"
              className={
                isSelected ? 'project-row selected-row' : 'project-row'
              }
              onClick={() => {
                setActivePayload(payload);
                setDraftName(project.data?.name ?? '');
              }}
            >
              <span>
                <strong>{project.data?.name ?? 'Loading project'}</strong>
                <small>{project.queryMetadata.label}</small>
              </span>
              <em
                className={`health health-${project.data?.health ?? 'yellow'}`}
              >
                {project.data
                  ? healthLabels[project.data.health]
                  : project.status}
              </em>
            </button>
          );
        })}
      </div>

      <div className="project-detail">
        <div>
          <p className="app-kicker">Selected project</p>
          <h3>{activeProject.data?.name ?? 'Loading project'}</h3>
        </div>
        <label className="field">
          Project name
          <input
            value={draftName}
            onChange={(event) => setDraftName(event.currentTarget.value)}
          />
        </label>
        <div className="task-list">
          {(activeProject.data?.tasks ?? []).map((task) => (
            <div key={task.id}>
              <span>{task.title}</span>
              <strong>{task.done ? 'Done' : 'Open'}</strong>
            </div>
          ))}
        </div>
        <div className="inline-actions">
          <button
            type="button"
            className="primary-button"
            onClick={() => {
              void renameProject(activePayload, draftName);
            }}
          >
            Save project
          </button>
          <button
            type="button"
            onClick={() => {
              void toggleFirstProjectTask(activePayload);
            }}
          >
            Toggle first task
          </button>
        </div>
      </div>
    </section>
  );
}
