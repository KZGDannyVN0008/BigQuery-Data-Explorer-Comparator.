import { ok } from '@/lib/api';
import { listProjects } from '@/lib/services/catalog';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return ok({ projects: listProjects() });
}
