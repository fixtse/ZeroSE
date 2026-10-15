import { marked } from 'marked';
import { Config } from '../../domain/config.js';
import { jsonRequest, RemoteError } from './http.js';

const id = (value: string) => encodeURIComponent(value);
export class Google {
  private tokens = new Map<string, { token: string; expires: number }>();
  private refreshing = new Map<string, Promise<string>>();
  constructor(
    readonly config: Config['google'],
    private timezone: string,
  ) {}
  get enabled() {
    return (
      !!this.config.refreshToken ||
      Object.values(this.config.credentials).some((c) => !!c?.refreshToken)
    );
  }
  private async accessToken(service = 'drive'): Promise<string> {
    const cached = this.tokens.get(service);
    if (cached && cached.expires > Date.now() + 60_000) return cached.token;
    const running = this.refreshing.get(service);
    if (running) return running;
    const credential =
      this.config.credentials[service as keyof typeof this.config.credentials] || this.config;
    const request = (async () => {
      if (!credential.refreshToken) throw new Error(`Google ${service} OAuth is not configured`);
      const result = await jsonRequest(
        'https://oauth2.googleapis.com/token',
        {
          method: 'POST',
          body: new URLSearchParams({
            client_id: credential.clientId,
            client_secret: credential.clientSecret,
            refresh_token: credential.refreshToken,
            grant_type: 'refresh_token',
          }),
        },
        'Google OAuth',
      );
      this.tokens.set(service, {
        token: result.access_token,
        expires: Date.now() + result.expires_in * 1000,
      });
      return String(result.access_token);
    })();
    this.refreshing.set(service, request);
    try {
      return await request;
    } finally {
      this.refreshing.delete(service);
    }
  }
  async request(api: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<any> {
    const service = api.split('/')[0];
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.accessToken(service);
      try {
        return await jsonRequest(
          api.startsWith('docs/')
            ? 'https://docs.googleapis.com/' + api.slice('docs/'.length)
            : 'https://www.googleapis.com/' + api,
          {
            method,
            signal,
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          },
          'Google',
        );
      } catch (e) {
        if (!(e instanceof RemoteError) || e.status !== 401 || attempt) throw e;
        this.tokens.delete(service);
      }
    }
  }
  private async list(api: string, query: Record<string, string> = {}, signal?: AbortSignal) {
    const items: any[] = [];
    let pageToken = '';
    const seen = new Set<string>();
    for (let page = 0; page < 100; page++) {
      const result = await this.request(
        api + '?' + new URLSearchParams({ ...query, ...(pageToken ? { pageToken } : {}) }),
        'GET',
        undefined,
        signal,
      );
      items.push(...(result.items || []));
      pageToken = result.nextPageToken;
      if (!pageToken) return items;
      if (seen.has(pageToken)) throw new Error('Google repeated a pagination token');
      seen.add(pageToken);
    }
    throw new Error('Google list exceeded the pagination limit');
  }
  private get calendar() {
    return `calendar/v3/calendars/${id(this.config.calendarId)}`;
  }
  private get taskList() {
    return `tasks/v1/lists/${id(this.config.taskListId)}/tasks`;
  }
  events(start: string, end: string, signal?: AbortSignal) {
    return this.list(
      this.calendar + '/events',
      {
        timeMin: start,
        timeMax: end,
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: '250',
      },
      signal,
    );
  }
  tasks(includeCompleted = false, signal?: AbortSignal) {
    return this.list(
      this.taskList,
      {
        showCompleted: String(includeCompleted),
        showHidden: String(includeCompleted),
        maxResults: '100',
      },
      signal,
    );
  }
  async cleanTasks(signal?: AbortSignal) {
    const items = await this.tasks(true, signal);
    for (const t of items)
      await this.request(`${this.taskList}/${id(t.id)}`, 'DELETE', undefined, signal);
    return { deleted: items.length };
  }
  async context(signal?: AbortSignal): Promise<string> {
    if (!this.config.contextDocumentId) return '';
    const doc = await this.request(
      `docs/v1/documents/${id(this.config.contextDocumentId)}`,
      'GET',
      undefined,
      signal,
    );
    const parts: string[] = [];
    function visit(node: any) {
      if (!node || typeof node !== 'object') return;
      if (node.textRun?.content) parts.push(node.textRun.content);
      for (const [key, value] of Object.entries(node))
        if (key !== 'textRun') {
          if (Array.isArray(value)) value.forEach(visit);
          else if (typeof value === 'object') visit(value);
        }
    }
    visit(doc.body);
    return parts.join('');
  }
  saveContext(memory: string, signal?: AbortSignal) {
    if (!this.config.contextDocumentId) throw new Error('Context Google Doc is not configured');
    return this.request(
      `docs/v1/documents/${id(this.config.contextDocumentId)}:batchUpdate`,
      'POST',
      { requests: [{ insertText: { endOfSegmentLocation: {}, text: `\n- ${memory}\n` } }] },
      signal,
    );
  }
  async createDocument(title: string, markdown: string, signal?: AbortSignal) {
    // Drive converts HTML to a native Google document, preserving Markdown formatting.
    const html = await marked.parse(markdown),
      boundary = 'fixt_' + crypto.randomUUID().replaceAll('-', '');
    const metadata = {
      name: title,
      mimeType: 'application/vnd.google-apps.document',
      ...(this.config.documentFolderId ? { parents: [this.config.documentFolderId] } : {}),
    };
    const multipart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n${html}\r\n--${boundary}--`;
    const response = await jsonRequest(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink,exportLinks',
      {
        method: 'POST',
        signal,
        headers: {
          Authorization: `Bearer ${await this.accessToken()}`,
          'Content-Type': `multipart/related; boundary=${boundary}`,
        },
        body: multipart,
      },
      'Google Drive',
    );
    return {
      id: response.id,
      url: response.webViewLink || `https://docs.google.com/document/d/${response.id}/edit`,
      download_url:
        response.exportLinks?.['application/pdf'] ||
        `https://docs.google.com/document/d/${response.id}/export?format=pdf`,
    };
  }
  availability(start: string, end: string, signal?: AbortSignal) {
    return this.request(
      'calendar/v3/freeBusy',
      'POST',
      {
        timeMin: start,
        timeMax: end,
        timeZone: this.timezone,
        items: [{ id: this.config.calendarId }],
      },
      signal,
    );
  }
  event(eventId: string, signal?: AbortSignal) {
    return this.request(`${this.calendar}/events/${id(eventId)}`, 'GET', undefined, signal);
  }
  private eventBody(value: any) {
    return {
      ...value,
      start: { dateTime: value.start, timeZone: this.timezone },
      end: { dateTime: value.end, timeZone: this.timezone },
      ...(value.attendees
        ? { attendees: value.attendees.map((email: string) => ({ email })) }
        : {}),
    };
  }
  createEvent(value: any, signal?: AbortSignal) {
    return this.request(`${this.calendar}/events`, 'POST', this.eventBody(value), signal);
  }
  updateEvent(eventId: string, value: any, signal?: AbortSignal) {
    return this.request(
      `${this.calendar}/events/${id(eventId)}`,
      'PATCH',
      this.eventBody(value),
      signal,
    );
  }
  deleteEvent(eventId: string, signal?: AbortSignal) {
    return this.request(`${this.calendar}/events/${id(eventId)}`, 'DELETE', undefined, signal);
  }
  task(taskId: string, signal?: AbortSignal) {
    return this.request(`${this.taskList}/${id(taskId)}`, 'GET', undefined, signal);
  }
  createTask(value: any, signal?: AbortSignal) {
    return this.request(this.taskList, 'POST', value, signal);
  }
  updateTask(taskId: string, value: any, signal?: AbortSignal) {
    return this.request(`${this.taskList}/${id(taskId)}`, 'PATCH', value, signal);
  }
  deleteTask(taskId: string, signal?: AbortSignal) {
    return this.request(`${this.taskList}/${id(taskId)}`, 'DELETE', undefined, signal);
  }
}
