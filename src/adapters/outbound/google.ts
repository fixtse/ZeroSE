import type { DocumentCreateOptions } from '../../application/ports.js';
import {
  contentWidth,
  oversizedImageRequests,
  paragraphRequests,
  tableCellStyle,
  validateImport,
  type DocsNode,
  type DocsRequest,
  type ImportedDocument,
} from './google-document.js';
import type {
  GoogleDestinationKind,
  GoogleDestinationQuery,
} from '../../application/admin-catalog.js';
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
  async destinations(
    kind: GoogleDestinationKind,
    query: GoogleDestinationQuery,
    signal: AbortSignal,
  ) {
    const folders = kind === 'document-folders';
    const params = new URLSearchParams({
      [folders ? 'pageSize' : 'maxResults']: String(query.limit),
      ...(query.pageToken ? { pageToken: query.pageToken } : {}),
      ...(folders
        ? {
            q: "mimeType = 'application/vnd.google-apps.folder' and trashed = false",
            fields: 'nextPageToken,files(id,name,capabilities(canAddChildren))',
            orderBy: 'name',
          }
        : kind === 'calendars'
          ? { minAccessRole: 'writer' }
          : {}),
    });
    if (folders && query.search) {
      const escaped = query.search.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
      params.set('q', params.get('q') + " and name contains '" + escaped + "'");
    }
    const endpoint = folders
      ? 'drive/v3/files'
      : kind === 'calendars'
        ? 'calendar/v3/users/me/calendarList'
        : 'tasks/v1/users/@me/lists';
    const result = await this.request(endpoint + '?' + params, 'GET', undefined, signal);
    const items = (folders ? result.files : result.items) || [];
    return {
      items: items
        .filter(
          (item: any) =>
            (!folders || item.capabilities?.canAddChildren !== false) &&
            (folders ||
              String(item.summary || item.title || '')
                .toLocaleLowerCase()
                .includes(query.search.toLocaleLowerCase())),
        )
        .map((item: any) => ({
          id: String(item.id),
          name: String(
            item.name || item.summaryOverride || item.summary || item.title || item.id,
          ).slice(0, 300),
        })),
      ...(result.nextPageToken ? { nextPageToken: String(result.nextPageToken) } : {}),
    };
  }
  async destination(kind: GoogleDestinationKind, destinationId: string, signal: AbortSignal) {
    if (kind === 'document-folders' && !destinationId)
      return { id: '', name: 'Mi unidad (sin carpeta)' };
    if (kind === 'calendars' && destinationId === 'primary')
      return { id: 'primary', name: 'Calendario principal' };
    if (kind === 'task-lists' && destinationId === '@default')
      return { id: '@default', name: 'Lista predeterminada' };
    const endpoint =
      kind === 'calendars'
        ? 'calendar/v3/users/me/calendarList/' + id(destinationId)
        : kind === 'task-lists'
          ? 'tasks/v1/users/@me/lists/' + id(destinationId)
          : 'drive/v3/files/' +
            id(destinationId) +
            '?fields=id,name,mimeType,capabilities(canAddChildren)';
    const item = await this.request(endpoint, 'GET', undefined, signal);
    if (
      (kind === 'calendars' && !['owner', 'writer'].includes(item.accessRole)) ||
      (kind === 'document-folders' &&
        (item.mimeType !== 'application/vnd.google-apps.folder' ||
          item.capabilities?.canAddChildren === false))
    )
      throw new Error('El destino no permite guardar contenido.');
    return {
      id: String(item.id),
      name: String(
        item.summaryOverride || item.summary || item.title || item.name || item.id,
      ).slice(0, 300),
    };
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
  async createDocument(
    title: string,
    html: string,
    signal?: AbortSignal,
    options: DocumentCreateOptions = {},
  ) {
    if (!html.trim()) throw new Error('Document HTML is required');
    if (!!options.documentId !== !!options.mode)
      throw new Error(
        'Existing documents require document_id and an explicit append or replace mode',
      );
    if (options.mode && !['append', 'replace'].includes(options.mode))
      throw new Error('Invalid document mode');
    if (options.documentId && !/^[a-zA-Z0-9_-]{1,200}$/.test(options.documentId))
      throw new Error('Invalid Google document ID');
    if (Buffer.byteLength(html, 'utf8') > 1_000_000) throw new Error('Document HTML exceeds 1 MB');
    const targetId = options.documentId;
    const read = (documentId: string) =>
      this.request(
        `docs/v1/documents/${id(documentId)}`,
        'GET',
        undefined,
        signal,
      ) as Promise<ImportedDocument>;
    // Check access and capture a revision before any temporary import or target mutation.
    const target = targetId ? await read(targetId) : undefined;
    if (target && (!target.body?.content || !target.revisionId))
      throw new Error('Target document body or revision is unavailable');
    const boundary = 'fixt_' + crypto.randomUUID().replaceAll('-', '');
    const metadata = {
      name: targetId ? 'Zero HTML import (temporary)' : title,
      mimeType: 'application/vnd.google-apps.document',
      ...(!targetId && this.config.documentFolderId
        ? { parents: [this.config.documentFolderId] }
        : {}),
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
    const documentId = targetId || response.id;
    if (!response.id)
      throw new Error(
        'Google Drive did not return the imported document ID; do not replay this mutation',
      );
    const result: Record<string, unknown> = {
      id: documentId,
      url: targetId
        ? `https://docs.google.com/document/d/${documentId}/edit`
        : response.webViewLink || `https://docs.google.com/document/d/${documentId}/edit`,
      download_url:
        (!targetId && response.exportLinks?.['application/pdf']) ||
        `https://docs.google.com/document/d/${documentId}/export?format=pdf`,
      mode: options.mode || 'create',
    };
    let attempted = false;
    let operationError: Error | undefined;
    try {
      const imported = await read(response.id);
      let revision = (target || imported).revisionId;
      const write = async (requests: DocsRequest[]) => {
        if (!requests.length) return;
        if (!revision) throw new Error('Document revision is unavailable');
        attempted = true;
        const updated = await this.request(
          `docs/v1/documents/${id(documentId)}:batchUpdate`,
          'POST',
          { requests, writeControl: { requiredRevisionId: revision } },
          signal,
        );
        revision = updated.writeControl?.requiredRevisionId;
      };
      if (!target) {
        await write(oversizedImageRequests(imported));
      } else {
        validateImport(imported);
        const endIndex = target.body.content.at(-1)?.endIndex;
        if (!Number.isInteger(endIndex) || endIndex < 2)
          throw new Error('Target document has an invalid body range');
        const index = options.mode === 'replace' ? 1 : endIndex;
        if (options.mode === 'replace') {
          if (endIndex > 2)
            await write([
              { deleteContentRange: { range: { startIndex: 1, endIndex: endIndex - 1 } } },
            ]);
        } else await write([{ insertText: { location: { index: endIndex - 1 }, text: '\n' } }]);
        const copy = async (
          nodes: DocsNode[],
          insertionIndex: number,
          maxWidth: number,
        ): Promise<void> => {
          const pending: DocsRequest[] = [];
          const flush = async () => {
            if (pending.length) await write(pending.splice(0));
          };
          // Work backwards so earlier insertions never invalidate later source locations.
          let reuseFinalParagraph = true;
          for (const node of [...nodes].reverse()) {
            if (node.sectionBreak) continue;
            if (node.paragraph) {
              pending.push(
                ...paragraphRequests(
                  imported,
                  node.paragraph,
                  insertionIndex,
                  maxWidth,
                  reuseFinalParagraph,
                ),
              );
              reuseFinalParagraph = false;
              if (pending.length >= 500) await flush();
            } else if (node.table) {
              reuseFinalParagraph = false;
              await flush();
              await write([
                {
                  insertTable: {
                    rows: node.table.rows,
                    columns: node.table.columns,
                    location: { index: insertionIndex },
                  },
                },
              ]);
              // Docs requires a separate read/write round to populate newly inserted tables.
              const current = await read(documentId);
              if (current.revisionId !== revision)
                throw new Error(
                  'Document changed during formatting; remaining writes were stopped',
                );
              const findTable = (content: DocsNode[]): DocsNode | undefined => {
                for (const element of content) {
                  if (element.table && element.startIndex === insertionIndex + 1) return element;
                  if (element.table)
                    for (const row of element.table.tableRows)
                      for (const cell of row.tableCells) {
                        const found = findTable(cell.content);
                        if (found) return found;
                      }
                }
              };
              const table = findTable(current.body.content);
              if (!table) throw new Error('Inserted table could not be located');
              for (let r = node.table.rows - 1; r >= 0; r--)
                for (let c = node.table.columns - 1; c >= 0; c--) {
                  const sourceCell = node.table.tableRows[r].tableCells[c];
                  const style = tableCellStyle(sourceCell.tableCellStyle);
                  if (Object.keys(style).length)
                    await write([
                      {
                        updateTableCellStyle: {
                          tableRange: {
                            tableCellLocation: {
                              tableStartLocation: { index: table.startIndex },
                              rowIndex: r,
                              columnIndex: c,
                            },
                            rowSpan: 1,
                            columnSpan: 1,
                          },
                          tableCellStyle: style,
                          fields: Object.keys(style).join(','),
                        },
                      },
                    ]);
                  await copy(
                    sourceCell.content,
                    table.table.tableRows[r].tableCells[c].content[0].startIndex,
                    maxWidth / node.table.columns,
                  );
                }
            }
          }
          await flush();
        };
        await copy(imported.body.content, index, contentWidth(target));
      }
      return result;
    } catch (error) {
      operationError =
        attempted || !targetId
          ? new Error(
              `Document ${documentId} may already have changed (${result.url}); do not automatically retry. ${error instanceof Error ? error.message : String(error)}`,
            )
          : error instanceof Error
            ? error
            : new Error(String(error));
      throw operationError;
    } finally {
      if (targetId) {
        try {
          // Cleanup is bounded and independent of a cancelled user operation.
          await this.request(
            `drive/v3/files/${id(response.id)}`,
            'DELETE',
            undefined,
            AbortSignal.timeout(10_000),
          );
        } catch {
          // Expose recovery information without replaying the content mutation.
          result.warning = 'Temporary HTML import could not be removed';
          result.temporary_document_id = response.id;
          if (operationError)
            operationError.message += ` Temporary import ${response.id} could not be removed.`;
        }
      }
    }
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
