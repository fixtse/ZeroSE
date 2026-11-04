import { z } from 'zod';
import { HomeAssistantExposure } from './home-assistant-exposure.js';
import { homeAssistantCommand } from './home-assistant-socket.js';
import type { Config } from '../../domain/config.js';
import type { TaskProviderPort } from '../../application/task-provider.js';
import { jsonRequest, jsonBody } from './http.js';

const itemSchema = z.object({
  uid: z.string().min(1),
  summary: z.string(),
  status: z.enum(['needs_action', 'completed']),
  description: z.string().optional(),
  due: z.string().optional(),
});
const inputSchema = z.object({
  title: z.string().optional(),
  notes: z.string().optional(),
  due: z.string().optional(),
  status: z.enum(['needsAction', 'completed']).optional(),
});

export class HomeAssistantTasks implements TaskProviderPort {
  constructor(
    private config: Config['homeAssistant'],
    private command = homeAssistantCommand,
  ) {}
  private async request(action: string, data: Record<string, unknown>, signal?: AbortSignal) {
    const entity = this.config.taskListEntity;
    if (!this.config.token || !entity || !/^todo\.[a-z0-9_]+$/.test(entity))
      throw new Error('Configure the selected Home Assistant task list and connection');
    await new HomeAssistantExposure(this.config, this.command).assert(
      [entity],
      signal,
      !action.startsWith('get_items'),
    );
    return jsonRequest(
      this.config.url.replace(/\/$/, '') + '/api/services/todo/' + action,
      {
        method: 'POST',
        ...jsonBody({ ...data, entity_id: entity }),
        headers: {
          Authorization: `Bearer ${this.config.token}`,
          'Content-Type': 'application/json',
        },
        signal,
      },
      'Home Assistant to-do',
    );
  }
  async tasks(includeCompleted = false, signal?: AbortSignal) {
    const result = await this.request('get_items?return_response', {}, signal);
    const items = z
      .array(itemSchema)
      .parse(result?.service_response?.[this.config.taskListEntity!]?.items);
    return items
      .filter((item) => includeCompleted || item.status !== 'completed')
      .map((item) => ({
        id: item.uid,
        title: item.summary,
        notes: item.description,
        due: item.due,
        status: item.status === 'completed' ? 'completed' : 'needsAction',
      }));
  }
  async task(id: string, signal?: AbortSignal) {
    const item = (await this.tasks(true, signal)).find((item) => item.id === id);
    if (!item) throw new Error('Task not found in the selected Home Assistant list');
    return item;
  }
  private fields(value: unknown, create: boolean) {
    const input = inputSchema.parse(value);
    if (create && !input.title?.trim()) throw new Error('Task title is required');
    const result: Record<string, unknown> = {};
    if (input.title !== undefined) result[create ? 'item' : 'rename'] = input.title;
    if (input.notes !== undefined) result.description = input.notes;
    if (input.status !== undefined)
      result.status = input.status === 'completed' ? 'completed' : 'needs_action';
    if (input.due !== undefined) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(input.due)) result.due_date = input.due;
      else if (Number.isFinite(Date.parse(input.due)))
        result.due_datetime = new Date(input.due).toISOString();
      else throw new Error('Use a valid due date or datetime');
    }
    return result;
  }
  async createTask(value: unknown, signal?: AbortSignal) {
    const fields = this.fields(value, true);
    await this.request('add_item', fields, signal);
    // HA does not return a UID. Do not guess from a non-unique title or replay the write.
    return { status: 'needsAction' };
  }
  async updateTask(id: string, value: unknown, signal?: AbortSignal) {
    const fields = this.fields(value, false);
    await this.task(id, signal);
    await this.request('update_item', { ...fields, item: id }, signal);
    return {
      id,
      ...(fields.status
        ? { status: fields.status === 'completed' ? 'completed' : 'needsAction' }
        : {}),
    };
  }
  async deleteTask(id: string, signal?: AbortSignal) {
    await this.task(id, signal);
    await this.request('remove_item', { item: id }, signal);
    return { id };
  }
  async cleanTasks(signal?: AbortSignal) {
    const items = await this.tasks(true, signal);
    for (const item of items) await this.request('remove_item', { item: item.id }, signal);
    return { deleted: items.length };
  }
}
