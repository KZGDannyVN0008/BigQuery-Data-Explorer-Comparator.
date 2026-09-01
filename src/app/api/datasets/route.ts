import { fail, ok } from '@/lib/api';
import { listDatasets } from '@/lib/services/catalog';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const project = new URL(request.url).searchParams.get('project');
    return ok({ datasets: await listDatasets(project ?? '') });
  } catch (error) {
    return fail(error);
  }
}
