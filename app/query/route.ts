import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.POSTGRES_URL!);

async function listInvoices() {
  try {
    const data = await sql`
      SELECT invoices.amount, customers.name
      FROM invoices
      JOIN customers ON invoices.customer_id = customers.id
      WHERE invoices.amount = 666;
    `;
    return data;
  } catch (err) {
    if (err instanceof Error && 'errors' in err) {
      const errors = err.errors as Error[];
      console.log('Total errors:', errors.length);
      errors.forEach((individualError, index) => {
        console.error(`Error ${index}:`, individualError.message);
        console.error(`Stack ${index}:`, individualError.stack);
      });
    }
    throw err;
  }
}

export async function GET() {
  try {
    return Response.json(await listInvoices());
  } catch (error) {
    return Response.json({ error }, { status: 500 });
  }
}
