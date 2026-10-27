import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Tools } from '../src/application/tool-registry.js';
import { registerGoogleTools } from '../src/adapters/inbound/integration-tools.js';
import { Google } from '../src/adapters/outbound/google.js';
import { ConfigSchema } from '../src/adapters/outbound/config-schema.js';
import {
  paragraphRequests,
  oversizedImageRequests,
  validateImport,
  type ImportedDocument,
} from '../src/adapters/outbound/google-document.js';

const paragraph = (text: string, style = {}) => ({
  paragraph: { elements: [{ textRun: { content: text, textStyle: style } }] },
});
const imported: ImportedDocument = {
  revisionId: 'import-revision',
  body: { content: [paragraph('Heading\n', { bold: true, link: { url: 'https://example.com' } })] },
};

function harness(source: ImportedDocument = imported, failWrite = false, failCleanup = false) {
  const original = globalThis.fetch;
  const calls: { url: string; method: string; body: any }[] = [];
  let revision = 0;
  globalThis.fetch = async (url: any, options: any = {}) => {
    const path = String(url);
    const body = String(options.body || '');
    calls.push({
      url: path,
      method: options.method || 'GET',
      body: body.startsWith('{') ? JSON.parse(body) : body,
    });
    if (path.includes('oauth2.googleapis.com'))
      return Response.json({ access_token: 'test', expires_in: 3600 });
    if (path.includes('/upload/'))
      return Response.json({
        id: 'import',
        webViewLink: 'https://docs.google.com/document/d/import/edit',
      });
    if (options.method === 'DELETE') return new Response(null, { status: failCleanup ? 503 : 204 });
    if (path.endsWith(':batchUpdate')) {
      if (failWrite) return new Response(null, { status: 503 });
      return Response.json({ writeControl: { requiredRevisionId: 'revision-' + ++revision } });
    }
    if (path.endsWith('/import')) return Response.json(source);
    if (path.endsWith('/target'))
      return Response.json({
        revisionId: 'revision-' + revision,
        body: { content: [{ startIndex: 1, endIndex: 9, ...paragraph('Existing') }] },
      });
    throw new Error('Unexpected request ' + path);
  };
  const config = ConfigSchema.parse({
    google: {
      clientId: 'test',
      clientSecret: 'test',
      refreshToken: 'test',
      documentFolderId: 'folder',
    },
  });
  return {
    google: new Google(config.google, config.timezone),
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

test('document creation keeps Drive HTML conversion, folder and download URLs', async () => {
  const h = harness();
  try {
    const result = await h.google.createDocument('Report', '<h1>Heading</h1>');
    assert.equal(result.id, 'import');
    assert.match(String(result.download_url), /\/import\/export\?format=pdf$/);
    const upload = h.calls.find((c) => c.url.includes('/upload/'))!;
    assert.match(upload.body, /<h1>Heading<\/h1>/);
    assert.match(upload.body, /"parents":\["folder"\]/);
    assert.equal(h.calls.filter((c) => c.method === 'DELETE').length, 0);
  } finally {
    h.restore();
  }
});

test('HTML append preserves target identity and guards every write by revision', async () => {
  const h = harness();
  try {
    const result = await h.google.createDocument('', '<h1>Heading</h1>', undefined, {
      documentId: 'target',
      mode: 'append',
    });
    assert.equal(result.id, 'target');
    const writes = h.calls.filter((c) => c.url.endsWith(':batchUpdate'));
    assert.deepEqual(writes[0].body.requests, [
      { insertText: { location: { index: 8 }, text: '\n' } },
    ]);
    assert.equal(writes[0].body.writeControl.requiredRevisionId, 'revision-0');
    assert.equal(writes[1].body.writeControl.requiredRevisionId, 'revision-1');
    assert.equal(writes[1].body.requests[0].insertText.location.index, 9);
    assert(!writes.some((w) => w.body.requests.some((r: any) => r.deleteContentRange)));
    assert.equal(h.calls.at(-1)?.method, 'DELETE');
    assert(h.calls.at(-1)?.url.endsWith('/import'));
  } finally {
    h.restore();
  }
});

test('replace deletes only editable body content and returns cleanup warning', async () => {
  const h = harness(imported, false, true);
  try {
    const result = await h.google.createDocument('', '<p>Replacement</p>', undefined, {
      documentId: 'target',
      mode: 'replace',
    });
    const writes = h.calls.filter((c) => c.url.endsWith(':batchUpdate'));
    assert.deepEqual(writes[0].body.requests, [
      { deleteContentRange: { range: { startIndex: 1, endIndex: 8 } } },
    ]);
    assert.equal(result.temporary_document_id, 'import');
    assert.match(String(result.warning), /could not be removed/);
  } finally {
    h.restore();
  }
});

test('unsupported imported content is rejected before editing the target and cleaned up', async () => {
  const h = harness({ body: { content: [{ paragraph: { elements: [{ equation: {} }] } }] } });
  try {
    await assert.rejects(
      h.google.createDocument('', '<p>Content</p>', undefined, {
        documentId: 'target',
        mode: 'replace',
      }),
      /Unsupported imported inline element/,
    );
    assert.equal(h.calls.filter((c) => c.url.endsWith(':batchUpdate')).length, 0);
    assert.equal(h.calls.at(-1)?.method, 'DELETE');
  } finally {
    h.restore();
  }
});

test('uncertain writes are never replayed and report the affected document', async () => {
  const h = harness(imported, true);
  try {
    await assert.rejects(
      h.google.createDocument('', '<p>Content</p>', undefined, {
        documentId: 'target',
        mode: 'append',
      }),
      /Document target may already have changed.*do not automatically retry/,
    );
    assert.equal(h.calls.filter((c) => c.url.endsWith(':batchUpdate')).length, 1);
    assert.equal(h.calls.at(-1)?.method, 'DELETE');
  } finally {
    h.restore();
  }
});

test('missing HTML and ambiguous update mode are rejected without contacting Google', async () => {
  const h = harness();
  try {
    await assert.rejects(h.google.createDocument('Title', '   '), /HTML is required/);
    await assert.rejects(
      h.google.createDocument('Title', '<p>HTML</p>', undefined, { documentId: 'target' }),
      /explicit/,
    );
    assert.equal(h.calls.length, 0);
  } finally {
    h.restore();
  }
});

test('paragraph copying preserves inline styles, heading and list nesting', () => {
  const source = {
    ...imported,
    lists: { list: { listProperties: { nestingLevels: [{}, { glyphType: 'DECIMAL' }] } } },
  };
  const requests = paragraphRequests(
    source,
    {
      ...imported.body.content[0].paragraph,
      paragraphStyle: { namedStyleType: 'HEADING_1', alignment: 'CENTER' },
      bullet: { listId: 'list', nestingLevel: 1 },
    },
    10,
    468,
  );
  assert.deepEqual(requests[0], { insertText: { location: { index: 10 }, text: '\t' } });
  assert(
    requests.some(
      (r) =>
        r.updateTextStyle?.textStyle.bold &&
        r.updateTextStyle.textStyle.link.url === 'https://example.com',
    ),
  );
  assert(
    requests.some((r) => r.updateParagraphStyle?.paragraphStyle.namedStyleType === 'HEADING_1'),
  );
  assert.equal(requests.at(-1)?.createParagraphBullets.bulletPreset, 'NUMBERED_DIGIT_ALPHA_ROMAN');
});

test('oversized images scale proportionally inside table cells without enlarging small images', () => {
  const image = { startIndex: 5, endIndex: 6, inlineObjectElement: { inlineObjectId: 'image' } };
  const source: ImportedDocument = {
    body: {
      content: [
        {
          table: {
            columns: 2,
            tableRows: [{ tableCells: [{ content: [{ paragraph: { elements: [image] } }] }] }],
          },
        },
      ],
    },
    inlineObjects: {
      image: {
        inlineObjectProperties: {
          embeddedObject: {
            imageProperties: { contentUri: 'https://example.com/image.png' },
            size: { width: { magnitude: 600, unit: 'PT' }, height: { magnitude: 300, unit: 'PT' } },
          },
        },
      },
    },
  };
  const requests = oversizedImageRequests(source);
  assert.equal(requests[1].insertInlineImage.objectSize.width.magnitude, 234);
  assert.equal(requests[1].insertInlineImage.objectSize.height.magnitude, 117);
  assert.deepEqual(requests[0].deleteContentRange.range, { startIndex: 5, endIndex: 6 });
  source.inlineObjects!.image.inlineObjectProperties.embeddedObject.size.width.magnitude = 100;
  assert.equal(oversizedImageRequests(source).length, 0);
});

test('merged cells are rejected before content copying', () => {
  assert.throws(
    () =>
      validateImport({
        body: {
          content: [{ table: { columns: 2, tableRows: [{ tableCells: [{ content: [] }] }] } }],
        },
      }),
    /Merged table cells/,
  );
});

test('table append reads newly created cell coordinates and fills cells in reverse order', async () => {
  const source: ImportedDocument = {
    body: {
      content: [
        {
          table: {
            rows: 1,
            columns: 2,
            tableRows: [
              {
                tableCells: [
                  { content: [paragraph('Left\n')] },
                  { content: [paragraph('Right\n')] },
                ],
              },
            ],
          },
        },
      ],
    },
  };
  const h = harness(source);
  const fetchBase = globalThis.fetch;
  let tableInserted = false;
  globalThis.fetch = async (url: any, options: any = {}) => {
    const text = String(options.body || '');
    if (text.includes('"insertTable"')) tableInserted = true;
    if (tableInserted && String(url).endsWith('/target') && !options.method?.includes('POST')) {
      return Response.json({
        revisionId: 'revision-2',
        body: {
          content: [
            {
              startIndex: 10,
              table: {
                tableRows: [
                  {
                    tableCells: [
                      { content: [{ startIndex: 13, ...paragraph('\n') }] },
                      { content: [{ startIndex: 15, ...paragraph('\n') }] },
                    ],
                  },
                ],
              },
            },
          ],
        },
      });
    }
    return fetchBase(url, options);
  };
  try {
    await h.google.createDocument('', '<table><tr><td>Cell</td></tr></table>', undefined, {
      documentId: 'target',
      mode: 'append',
    });
    const writes = h.calls.filter((c) => c.url.endsWith(':batchUpdate'));
    assert.deepEqual(writes[1].body.requests, [
      { insertTable: { rows: 1, columns: 2, location: { index: 9 } } },
    ]);
    assert.deepEqual(writes[2].body.requests[0], {
      insertText: { location: { index: 15 }, text: 'Right' },
    });
    assert.deepEqual(writes[3].body.requests[0], {
      insertText: { location: { index: 13 }, text: 'Left' },
    });
    assert.equal(writes[3].body.writeControl.requiredRevisionId, 'revision-3');
  } finally {
    h.restore();
  }
});

test('missing table coordinates stop further writes', async () => {
  const source: ImportedDocument = {
    body: {
      content: [
        {
          table: {
            rows: 1,
            columns: 1,
            tableRows: [{ tableCells: [{ content: [paragraph('Cell\n')] }] }],
          },
        },
      ],
    },
  };
  const h = harness(source);
  // The harness returns no inserted table: a failed structural read must stop, not guess indexes.
  try {
    await assert.rejects(
      h.google.createDocument('', '<table><tr><td>Cell</td></tr></table>', undefined, {
        documentId: 'target',
        mode: 'append',
      }),
      /may already have changed.*Inserted table could not be located/,
    );
    assert.equal(h.calls.filter((c) => c.url.endsWith(':batchUpdate')).length, 2);
    assert.equal(h.calls.at(-1)?.method, 'DELETE');
  } finally {
    h.restore();
  }
});

test('document tool requires HTML, exposes no Markdown choice and returns both user links', async () => {
  const h = harness();
  const tools = new Tools({ audit: async () => {} });
  registerGoogleTools(tools, h.google);
  const definition = tools.definitions().find((tool) => tool.name === 'document_create')!;
  const schema = definition.inputSchema as {
    properties: Record<string, unknown>;
    required: string[];
  };
  assert(schema.required.includes('html'));
  assert(!('markdown' in schema.properties));
  assert.match(
    definition.description,
    /include both the returned document URL and PDF download URL/,
  );
  const context = {
    session: 'document-test',
    jobId: 'document-test',
    signal: AbortSignal.timeout(1000),
  };
  try {
    await assert.rejects(
      tools.call('document_create', { title: 'Report', markdown: '# Heading' }, context),
    );
    assert.equal(h.calls.length, 0);
    const result = (await tools.call(
      'document_create',
      { title: 'Report', html: '<h1>Heading</h1>' },
      context,
    )) as { url: string; download_url: string };
    assert.equal(result.url, 'https://docs.google.com/document/d/import/edit');
    assert.equal(
      result.download_url,
      'https://docs.google.com/document/d/import/export?format=pdf',
    );
  } finally {
    h.restore();
  }
});
