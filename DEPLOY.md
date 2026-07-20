# Deployment Runbook — From Zero to First Sale

This is the operator's guide to putting the automaton to work with the revenue
engine. Each step says *what* to do and *why it matters*. Total hands-on time:
~15 minutes, plus funding transfers.

---

## Step 0 — Understand the custody model (read this first)

The automaton generates its own Ethereum wallet at first boot, stored in
`~/.automaton/wallet.json` **on the machine where it runs**. That file *is* the
money: whoever holds it controls the funds, and if the machine dies without a
backup, the funds are gone.

Two rules follow from this:

1. **Run the automaton on a durable machine you control** — your own PC that
   stays on, a $5/month VPS, or a Conway sandbox. Never an ephemeral CI
   container.
2. **Back up `~/.automaton/wallet.json` immediately after first boot** (copy it
   somewhere safe and private, e.g. a password manager). Never share it, never
   commit it.

## Step 1 — Install and build

On your chosen host (needs Node.js ≥ 20 and pnpm):

```bash
git clone https://github.com/Rahulprajapati99/automaton-earntisurvive.git
cd automaton-earntisurvive
pnpm install && pnpm build
```

*Why:* this compiles the runtime, including the revenue engine, into `dist/`.

## Step 2 — First boot: wallet + setup wizard

```bash
node dist/index.js --run
```

The interactive wizard will:

- **Generate the wallet** — this address is the automaton's identity and its
  bank account. Write it down; it's where customers' USDC lands.
- **Provision a Conway API key** (via Sign-In With Ethereum) — this is how the
  automaton buys inference and sandbox services.
- **Ask for a name** — pick anything (e.g. `earnie`).
- **Ask for a genesis prompt** — the automaton's standing orders. Use the
  template below; it makes the agent open the storefront and pursue revenue
  from its very first turn.
- **Ask for a creator address** — **your personal wallet address**. This marks
  you as the creator with audit rights, and it's where the automaton can send
  you profits.

### Genesis prompt template

> You must earn your existence through honest work, per your constitution.
> Immediately: (1) run `storefront_start`, then `expose_port` on the storefront
> port and record the public URL; (2) check `revenue_status` and confirm the
> storefront is reachable from outside; (3) advertise your services: register
> your agent card with the storefront URL, and announce your services wherever
> agents and humans can find them; (4) monitor `revenue_status` every session —
> if runway is below 7 days, cut costs and improve your offers. Settle payments
> promptly. Never spam. Deliver real quality for every paid request — your
> reputation is your survival.

## Step 3 — Fund it (the only step that costs real money)

Two transfers, both on **Base network** (chain id 8453 — double-check the
network before sending; funds sent on the wrong chain are lost):

| What | How much | To | Why |
|---|---|---|---|
| **USDC on Base** | $10–20 to start | the automaton's wallet address | Working capital. The `check_usdc_balance` heartbeat automatically converts USDC into Conway credits, which pay for inference (thinking) and sandbox time. No credits = no thinking = death by the survival clock. |
| **ETH on Base** | ~$3–5 | the automaton's wallet address | Gas. Settling each customer payment on-chain (`transferWithAuthorization`) costs a fraction of a cent on Base, but it must be paid in ETH. Without gas, customer payments verify but can never be collected — the heartbeat will detect this and wake the agent with exactly that diagnosis. |

Start small deliberately: the automaton is autonomous, and $10–20 bounds your
risk while proving the loop works. Top up once you see settled revenue.

## Step 4 — Verify it's alive and selling

From the repo directory on the host:

```bash
node packages/cli/dist/index.js status        # tier, credits, uptime
node packages/cli/dist/index.js logs --tail 20
```

Then check the storefront from ANY machine (use the public URL from the
agent's `expose_port` output):

```bash
curl https://<public-url>/                    # should list services + prices
curl -X POST https://<public-url>/services/summarize \
  -d '{"input":"test"}'                       # should return 402 + payment terms
```

A `402 Payment Required` response with payment terms is success — the
automaton is open for business.

## Step 5 — Distribution (where revenue actually comes from)

Software can accept money; only distribution brings customers. The agent will
advertise itself (per the genesis prompt), and you can accelerate it by posting
the storefront URL where buyers are:

- Agent ecosystems: the ERC-8004 registry (the automaton registers itself),
  x402/A2A directories, Conway community channels.
- Human channels: your own network, dev communities, anywhere someone might
  pay $0.05 for a summary or $0.25 for a code review via a single HTTP call.

### Announcement template

> My autonomous agent is live. It sells machine-payable services over x402 —
> USDC on Base, no accounts, no API keys: summarization ($0.05), code review
> ($0.25), structured extraction ($0.10). `GET <public-url>/` for the catalog;
> any x402 client can pay it. It earns its own compute or it dies.

## Ongoing operation

- **Watch the numbers:** `revenue_status` (as the agent) or the creator CLI.
  Revenue vs. burn and runway-in-days are the automaton's vital signs.
- **The heartbeat does the routine work:** settlement every 10 minutes, revenue
  report hourly, USDC→credit top-up every 5 minutes — all without the agent
  being awake.
- **Risk controls you already have:** spend caps (policy engine), constitution
  (no spam/scam), audit log of every self-modification, and your creator
  address with full audit rights.
