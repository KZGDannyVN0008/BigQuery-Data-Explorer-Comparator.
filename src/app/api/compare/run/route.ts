import { fail, ok, readJson, stringArray } from '@/lib/api';
import { assertTableRef } from '@/lib/identifiers';
import { runComparison } from '@/lib/services/compare';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = await readJson(request);
    const result = await runComparison({
      left: assertTableRef(body.left),
      right: assertTableRef(body.right),
      keyColumns: stringArray(body.keyColumns, 'keyColumns'),
      leftDateColumn: String(body.leftDateColumn ?? ''),
      rightDateColumn: String(body.rightDateColumn ?? ''),
      startDate: String(body.startDate ?? ''),
      endDate: String(body.endDate ?? ''),
      valueColumns: body.valueColumns === undefined ? undefined : stringArray(body.valueColumns, 'valueColumns'),
      page: body.page === undefined ? 0 : Number(body.page),
      pageSize: body.pageSize === undefined ? undefined : Number(body.pageSize),
    });
    return ok(result);
  } catch (error) {
    return fail(error);
  }
}
