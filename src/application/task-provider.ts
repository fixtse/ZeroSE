import type { GoogleToolsPort } from './ports.js';

export type TaskProviderPort = Pick<
  GoogleToolsPort,
  'tasks' | 'task' | 'createTask' | 'updateTask' | 'deleteTask' | 'cleanTasks'
>;

/** Explicit routing: a failed selected provider never falls back to another account. */
export function withTaskProvider(
  direct: GoogleToolsPort,
  tasks: TaskProviderPort,
): GoogleToolsPort {
  return {
    enabled: true,
    context: direct.context.bind(direct),
    events: direct.events.bind(direct),
    availability: direct.availability.bind(direct),
    event: direct.event.bind(direct),
    createEvent: direct.createEvent.bind(direct),
    updateEvent: direct.updateEvent.bind(direct),
    deleteEvent: direct.deleteEvent.bind(direct),
    saveContext: direct.saveContext.bind(direct),
    createDocument: direct.createDocument.bind(direct),
    tasks: tasks.tasks.bind(tasks),
    task: tasks.task.bind(tasks),
    createTask: tasks.createTask.bind(tasks),
    updateTask: tasks.updateTask.bind(tasks),
    deleteTask: tasks.deleteTask.bind(tasks),
    cleanTasks: tasks.cleanTasks.bind(tasks),
  };
}
