import { FreeBirdProvider } from "@freebirdai/react";
import { ChatPanel, DynamicGrid, CustomTabBar } from "@freebirdai/react-tailwind";
import { clientRegistry } from "./registry";

export function App() {
  return (
    <FreeBirdProvider
      registry={clientRegistry}
      transportOptions={{ baseUrl: "/freebird" }}
    >
      <div className="min-h-screen grid grid-cols-[320px_1fr] gap-4 p-4">
        <aside className="border border-white/10 rounded-2xl p-3 flex flex-col gap-3">
          <h1 className="text-lg font-semibold">FreeBird</h1>
          <CustomTabBar saveLabel="Save layout" emptyLabel="No saved tabs yet." />
          <div className="flex-1 min-h-0">
            <ChatPanel className="h-full" placeholder="Ask what you want to see…" />
          </div>
        </aside>
        <main className="border border-white/10 rounded-2xl p-3">
          <DynamicGrid showLocks />
        </main>
      </div>
    </FreeBirdProvider>
  );
}
