/** Standalone fake payment providers for E2E runs: `tsx tests/support/fake-payments-server.ts` (port FAKE_PAYMENTS_PORT, default 4010). */
import { startFakePayments } from "./fake-payments";

const port = Number(process.env.FAKE_PAYMENTS_PORT ?? 4010);
startFakePayments(port).then((f) => console.log(`fake payments on ${f.url}`));
