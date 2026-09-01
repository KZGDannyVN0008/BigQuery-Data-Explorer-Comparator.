import { fail, ok, readJson } from '@/lib/api';
import { assertProject } from '@/lib/identifiers';
import { getTableMetadata } from '@/lib/services/catalog';
import { suggestTargets } from '@/lib/services/compare';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = await readJson(request);
    const metadata = await getTableMetadata(body.ref);
    const targetProject = body.targetProject ? assertProject(body.targetProject) : undefined;
    return ok(await suggestTargets(metadata, targetProject));
  } catch (error) {
    return fail(error);
  }
}
