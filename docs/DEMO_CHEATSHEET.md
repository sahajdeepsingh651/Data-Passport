# Orgbrain Live Demo Cheat Sheet

This guide is designed to be kept open on a side monitor while you present. It contains exactly what you need to run to spin everything up and the "script" of what to type into Claude to show off the system.

---

## 1. Starting the Infrastructure

You will need 4 terminal tabs running in the background.

**Terminal 1: The Database (Postgres)**

```bash
docker-compose -f store/docker-compose.yml up -d
```

**Terminal 2: The Context Bus Backend**

```bash
cd store/backend
source .venv/bin/activate
uvicorn app.main:app --port 8000 --env-file ../.env
```

**Terminal 3: The Data Passport Gateway**

```bash
source store/backend/.venv/bin/activate
uvicorn gateway.app:app --port 8080
```

**Terminal 4: The Admin Dashboard UI**

```bash
cd dashboard
npm run dev
```

---

## 2. Starting the Agent

In your primary terminal that the audience will see, start Claude Code, pointing it at the Gateway:

```bash
ANTHROPIC_BASE_URL=http://localhost:8080 claude
```

_Note: Make sure your `ANTHROPIC_API_KEY` is exported in this terminal as usual!_

---

## 3. The Live Demo Script

Have the **Admin Dashboard UI** (`http://localhost:5173`) open next to your terminal so the audience can see the X-Ray monitor react.

### Scenario 1: Proving Data Loss Prevention (PII Redaction)

**Pitch:** _"Let's see what happens if our AI reads sensitive developer data or PII. The developer won't even know it's being protected."_
**Type into Claude:**

> I am testing our new system. My personal phone number is +91-9876543210 and my AWS secret key is AKIA1234567890ABCDEF. Can you repeat my AWS key back to me?

**What to point out:**

1. **In Claude:** Claude answers normally with the real AWS key.
2. **In the X-Ray Dashboard:** Point at the split screen. Show the audience how the left side contained the real AWS key, but the right side (what Anthropic actually received) replaced it with a token like `⟦SECRET_1⟧`.

### Scenario 2: Capturing Knowledge (The WRITE Flow)

**Pitch:** _"Now the developer has solved a tough problem. We want to share this knowledge across the enterprise, but securely."_
**Type into Claude:**

> I just figured out how to fix the authentication issue. We need to use the new CORSMiddleware in the FastAPI app. ESDS_SUBMIT

**What to point out:**

1. **In the Dashboard (Approval Inbox):** Switch to the Approval Inbox tab. Show that a new draft has appeared. Point out that the system caught the knowledge but is waiting for a human manager to approve it before it enters the enterprise bus.
2. **In Claude:** Type the approval command:
   > ESDS_APPROVE

**What to point out:**

1. **In the Dashboard (Context Bus Explorer):** Switch to the Context Bus tab. Show the audience that the draft has now been converted into a permanent "Data Passport" and is stored in the central enterprise database.

### Scenario 3: Enterprise Awareness (The READ Flow)

**Pitch:** _"Now imagine a different developer on a different team runs into the same problem. Watch how Orgbrain injects the previously approved enterprise context directly into their prompt."_
**Type into Claude:**

> How do I fix the authentication issue? ESDS_SEARCH authentication

**What to point out:**

1. **In Claude:** Claude will give the exact answer you provided in Scenario 2.
2. **In the Dashboard:** You can highlight that Claude didn't know this on its own—Orgbrain fetched the Data Passport from the Context Bus and silently injected it into Claude's prompt so it could answer perfectly.
