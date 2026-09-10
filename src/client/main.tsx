import { createRoot } from "react-dom/client";
import "./styles.css";

// M1 replaces this with the real decision shell (App.tsx, useDecisionAgent).
createRoot(document.getElementById("root")!).render(
  <main className="mx-auto max-w-2xl p-8">
    <h1 className="text-2xl font-semibold tracking-tight">Async Decision Facilitator</h1>
    <p className="mt-2 text-neutral-600">Deployed. Open a decision through its participant link.</p>
  </main>
);
