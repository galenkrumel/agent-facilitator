import { createRoot } from "react-dom/client";

// M1 replaces this with the real decision shell (App.tsx, useDecisionAgent).
createRoot(document.getElementById("root")!).render(
  <main style={{ font: "16px/1.5 system-ui, sans-serif", padding: "2rem" }}>
    <h1>Async Decision Facilitator</h1>
    <p>Deployed. Open a decision through its participant link.</p>
  </main>
);
