# Database Connection Errors — What They Mean and How to Fix Them

A reference for the `ETIMEDOUT` / `ENETUNREACH` errors you hit when connecting a Next.js app to a Neon Postgres database, and why switching to `@neondatabase/serverless` fixes them.

## The errors

```
Error: connect ETIMEDOUT 52.4.160.253:5432
Error: connect ENETUNREACH 2600:1f18:6000:1e0c:82b3:cc30:735b:5ee6:5432
```

Both errors mean **the TCP connection never got established** — your code couldn't even open a socket to the database. They are *not* SQL errors, authentication errors, or SSL errors. The packets either never reached the server or never got a reply.

Two distinct symptoms appear together:

| Error code      | What it means                                                                 |
| --------------- | ----------------------------------------------------------------------------- |
| `ETIMEDOUT`     | Packet sent, but no reply within the timeout. Usually a firewall is blocking. |
| `ENETUNREACH`   | OS has no route to that address family. Usually no IPv6 on your network.      |

When Node resolves a hostname like `ep-green-sun-...neon.tech`, DNS returns **multiple addresses** (several IPv4 + several IPv6). Node tries each one. You see one error per address that failed. That's why you see 6 errors for one query attempt.

## Root cause

The errors are caused by your **network blocking outbound port 5432** (the default Postgres port).

This is extremely common on:

- University / school Wi-Fi
- Corporate networks
- Hotel / café / airport Wi-Fi
- Some mobile carriers
- ISPs that block "server" ports on residential plans

These networks typically allow only "safe" ports — 80 (HTTP), 443 (HTTPS), 53 (DNS), 22 (SSH sometimes) — and silently drop everything else. Port 5432 falls into "everything else."

The IPv6 `ENETUNREACH` errors are a separate, parallel problem: most home/school networks don't have IPv6 routing set up, so any IPv6 address resolves but is unreachable. This is *normal* and usually harmless — Node falls back to IPv4. The real failure is IPv4 being blocked.

## How to confirm it's a network block

Run this from your terminal. If the connection hangs and eventually times out, port 5432 is blocked:

```bash
nc -zv ep-green-sun-ap591h54-pooler.c-7.us-east-1.aws.neon.tech 5432
```

If `psql` also fails with a similar timeout, it confirms the problem is at the network layer, not the code:

```bash
psql "$POSTGRES_URL" -c "SELECT 1"
```

## Why "switching networks didn't help"

Network blocking varies by network. Phone tethering, home Wi-Fi, school Wi-Fi, and café Wi-Fi can each behave differently — and the same Wi-Fi can behave differently at different times if the network admin changes firewall rules. There's no guarantee a network change will fix it, and it's beyond your control.

## The fix: use a driver that doesn't need port 5432

`@neondatabase/serverless` is Neon's official driver that talks to the database over **HTTPS (port 443)** instead of the raw Postgres protocol on port 5432. Port 443 is the same port your browser uses for every secure website — it is essentially never blocked.

It also has bonus properties:

- **No connection pooling concerns.** Each query is a stateless HTTP request — perfect for serverless / Next.js server components where each request is short-lived.
- **No cold-start handshake** drama. No long-lived TCP connection to drop.
- **Same SQL tagged-template syntax** as `postgres.js` — `` sql`SELECT ...` `` works identically.

### Installation

```bash
npm install @neondatabase/serverless
npm uninstall postgres
```

### Code change

Before (using `postgres.js`):

```ts
import postgres from 'postgres';
const sql = postgres(process.env.POSTGRES_URL!, { ssl: 'require' });
```

After (using Neon's HTTP driver):

```ts
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.POSTGRES_URL!);
```

The query calls themselves don't change:

```ts
const data = await sql`SELECT * FROM revenue`;
```

### One TypeScript gotcha

`postgres.js` supports generic syntax like `` sql<Revenue[]>`SELECT ...` ``. `@neondatabase/serverless` does not — use a type assertion instead:

```ts
// Before
const data = await sql<Revenue[]>`SELECT * FROM revenue`;

// After
const data = (await sql`SELECT * FROM revenue`) as Revenue[];
```

## When NOT to use the HTTP driver

The HTTP driver is great for short, stateless queries from serverless / edge / server-component contexts. It is *not* a fit for:

- **Transactions across multiple queries** — each `sql` call is a separate HTTP request, so they can't share a transaction. (Neon does offer `transaction()` and `neonConfig.transactionMode` but it's more limited than a real connection.)
- **`LISTEN` / `NOTIFY`** or any long-lived subscription
- **Very high query volume** on a single server — TCP pooling can be more efficient

For a Next.js app talking to Neon, you almost always want the HTTP driver. The cases above are rare and well-flagged when they apply.

## Summary checklist for future projects

When you see `ETIMEDOUT` on port 5432 in any Node project:

1. **Don't waste time** rotating credentials, checking SSL flags, or rewriting the connection string — those aren't the problem.
2. **Test the network** with `nc -zv <host> 5432`. If it hangs, the network is the cause.
3. **If your DB is on Neon** → switch to `@neondatabase/serverless` (HTTPS, port 443).
4. **If your DB is on Supabase** → they offer a similar HTTP-based client; or use their connection pooler on port 6543, which is sometimes allowed when 5432 isn't.
5. **If your DB is self-hosted** → put a connection proxy (e.g. PgBouncer + a TLS terminator) on port 443, or use a VPN to bypass the block.

The general principle: **port 443 always works, raw database ports often don't.** Pick a driver that respects that.

## Bonus pitfall: Node's `fetch` and IPv6

After switching to `@neondatabase/serverless`, you may *still* see `TypeError: fetch failed` with a `[cause] ETIMEDOUT` even though `curl` to the same Neon host works in seconds.

This is **not a network block** — it's a Node bug. DNS for Neon hosts returns both IPv4 and IPv6 addresses. Node's `fetch` (powered by `undici`) tries IPv6 first by default. If your network has no working IPv6 route (very common on home/school Wi-Fi), the IPv6 attempts time out and `fetch` doesn't fall back to IPv4 fast enough — the request fails.

`curl` avoids this with "Happy Eyeballs" (parallel IPv4/IPv6 attempts), but Node doesn't.

### How to recognize this version of the problem

- `curl https://<your-neon-host>/` returns an HTTP response within ~1 second (often `HTTP/2 400 "query is not supported"` — that's fine, it means HTTPS works)
- But `pnpm dev` / `npm run dev` still throws `fetch failed` / `ETIMEDOUT`
- `nslookup <neon-host>` shows both IPv4 and IPv6 addresses

### The fix

Tell Node to prefer IPv4 with the `--dns-result-order=ipv4first` flag. Set it via `NODE_OPTIONS`:

```bash
NODE_OPTIONS=--dns-result-order=ipv4first pnpm dev
```

Or bake it into your `package.json` so you don't forget:

```json
"scripts": {
  "dev": "NODE_OPTIONS=--dns-result-order=ipv4first next dev --turbopack"
}
```

This is safe to leave on permanently — it just changes DNS *priority*, not which addresses are usable. IPv6 still works if it's available; it's just no longer tried first.

## Final wrinkle: concurrent HTTPS requests can still flake

Even with the IPv4-first flag, **launching many concurrent HTTPS requests to Neon from a single page render can still trigger sporadic `fetch failed` / `ETIMEDOUT`** on flaky networks.

Symptom in this project: single-query functions like `fetchRevenue` (1 query) and `fetchLatestInvoices` (1 query) succeed reliably, but `fetchCardData` — which fires 3 queries via `Promise.all` — fails. The dashboard page renders all three components in parallel, so total concurrency on first paint is `1 + 1 + 3 = 5` HTTPS connections to the same Neon host opening at once. Something in Node's `undici` connection setup misbehaves under that concurrency on networks with broken IPv6, and one or more sockets time out.

### The fix

Serialize the queries inside the function. Replace:

```ts
const data = await Promise.all([
  sql`SELECT COUNT(*) FROM invoices`,
  sql`SELECT COUNT(*) FROM customers`,
  sql`SELECT ... FROM invoices`,
]);
```

with:

```ts
const invoiceCount = await sql`SELECT COUNT(*) FROM invoices`;
const customerCount = await sql`SELECT COUNT(*) FROM customers`;
const invoiceStatus = await sql`SELECT ... FROM invoices`;
```

You lose the parallelism, but each query only takes ~50-150ms over HTTPS so the user-perceived cost is small. On production (Vercel + Neon over IPv6-working network) you can switch back to `Promise.all` for the speedup.

Alternative: **combine the three queries into one** with subqueries. One round trip, fastest, but loses the pedagogical demo of `Promise.all`.

### Why this is OK for a learning project

The tutorial uses `Promise.all` to teach a real JavaScript pattern. The pattern is correct — it's the underlying network that's broken on the dev machine. When the same code runs on Vercel (where IPv6 works and there's no network filtering), the `Promise.all` version works fine and is genuinely faster.

The pattern: **debug code against your real deployment target, not just your laptop's network**. A Vercel preview deployment will often work when local dev doesn't, and that's not a bug in your code.
