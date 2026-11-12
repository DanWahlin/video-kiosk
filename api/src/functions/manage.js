// Video management API (Azure Static Web Apps managed functions).
// Static Web Apps signs people in with GitHub and lets only signed-in people call
// /api/manage/*. These functions also check that the GitHub username is in the
// MANAGERS app setting (for example "danwahlin,katiesavage").
import { app } from '@azure/functions';
import { HttpError, catalogNames, createUpload, getCatalog, getVersion, listVersions, publish } from '../store.js';

function principal(req) {
  const raw = req.headers.get('x-ms-client-principal');
  if (!raw) return null;
  try {
    return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

const managers = () =>
  new Set(
    (process.env.MANAGERS ?? '')
      .split(/[,\s]+/)
      .map((s) => s.trim().replace(/^@/, '').toLowerCase())
      .filter(Boolean),
  );

function authorize(req, { write = false } = {}) {
  const p = principal(req);
  if (!p?.userDetails || p.identityProvider !== 'github') throw new HttpError(401, 'Sign in with GitHub.');
  if (!managers().has(p.userDetails.toLowerCase())) throw new HttpError(403, `The GitHub account @${p.userDetails} is not approved for video management.`);
  // A page on another site cannot add this header without the browser asking first (CORS),
  // and this API does not allow other sites. So a change always comes from this site.
  if (write && req.headers.get('x-kiosk-manage') !== '1') throw new HttpError(403, 'Missing the X-Kiosk-Manage header.');
  return p.userDetails;
}

async function body(req) {
  if (!(req.headers.get('content-type') ?? '').startsWith('application/json')) throw new HttpError(415, 'Send JSON.');
  try {
    return await req.json();
  } catch {
    throw new HttpError(400, 'The request is not valid JSON.');
  }
}

const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

function route(name, methods, path, handler, { write = false } = {}) {
  app.http(name, {
    methods,
    route: `manage/${path}`,
    authLevel: 'anonymous',
    handler: async (req, ctx) => {
      try {
        const user = authorize(req, { write });
        return { status: 200, headers, jsonBody: await handler(req, user, ctx) };
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 500;
        if (status === 500) ctx.error(err);
        return { status, headers, jsonBody: { error: status === 500 ? 'Something went wrong on the server. Try again.' : err.message } };
      }
    },
  });
}

route('me', ['GET'], 'me', async (req, user) => ({ user, catalogs: catalogNames() }));

route('getCatalog', ['GET'], 'catalogs/{name}', (req) => getCatalog(req.params.name));

route(
  'publishCatalog',
  ['PUT'],
  'catalogs/{name}',
  async (req, user, ctx) => {
    const { catalog, etag = null, note = '' } = await body(req);
    const result = await publish(req.params.name, catalog, { etag, user, note: String(note).slice(0, 300) });
    ctx.log(`${user} published ${req.params.name} (${result.published.version})`);
    return result;
  },
  { write: true },
);

route('listVersions', ['GET'], 'catalogs/{name}/versions', (req) => listVersions(req.params.name));

route('getVersion', ['GET'], 'catalogs/{name}/versions/{id}', (req) => getVersion(req.params.name, req.params.id));

route(
  'createUpload',
  ['POST'],
  'uploads',
  async (req, user, ctx) => {
    const b = await body(req);
    const links = await createUpload({ folder: b.folder, fileName: b.fileName, size: b.size, captions: !!b.captions });
    ctx.log(`${user} is uploading ${links.video.url}`);
    return links;
  },
  { write: true },
);
