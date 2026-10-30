// @vitest-environment jsdom

import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Issue } from "@paperclipai/shared";
import type { IssueListFilters } from "../api/issues";
import { Issues } from "./Issues";

const mocks = vi.hoisted(() => ({ listCompact: vi.fn() }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: () => {} }) }));
vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname: "/issues", search: "" }),
  useSearchParams: () => [new URLSearchParams()],
}));
vi.mock("../hooks/useStreamlinedUiEnabled", () => ({ useStreamlinedUiEnabled: () => ({ enabled: false }) }));
vi.mock("../hooks/useCombinedInboxTasksEnabled", () => ({ useCombinedInboxTasksEnabled: () => ({ enabled: false }) }));
vi.mock("@/hooks/useSharedPolling", () => ({
  useSharedPollingQuery: () => ({ enabled: false }),
  usePublishSharedQueryData: () => {},
}));
vi.mock("../hooks/useUpdateIssueMutation", () => ({ useUpdateIssueMutation: () => ({ mutate: vi.fn() }) }));
vi.mock("../api/issues", () => ({ issuesApi: mocks }));
vi.mock("../api/agents", () => ({ agentsApi: { list: async () => [] } }));
vi.mock("../api/projects", () => ({ projectsApi: { list: async () => [] } }));
vi.mock("../components/IssuesList", () => ({
  IssuesList: ({ issues, onStatusFilterChange, onLoadMoreIssues }: {
    issues: Issue[];
    onStatusFilterChange?: (status: string) => void;
    onLoadMoreIssues?: () => void;
  }) => {
    useEffect(() => { onStatusFilterChange?.("backlog,in_review"); }, [onStatusFilterChange]);
    return <div>
      {issues.map((issue) => <span key={issue.id}>{issue.title}</span>)}
      <button onClick={() => onStatusFilterChange?.("done")}>Done</button>
      <button onClick={() => onStatusFilterChange?.("")}>All</button>
      <button onClick={onLoadMoreIssues}>More</button>
    </div>;
  },
}));

afterEach(() => { vi.clearAllMocks(); });

describe("Tasks status pagination", () => {
  it("finds older open tasks on the first filtered page and resets pagination when statuses change", async () => {
    const tasks = [
      ...Array.from({ length: 200 }, (_, index) => ({ id: `done-${index}`, title: `Done ${index}`, status: "done" })),
      { id: "review", title: "Review task", status: "in_review" },
      { id: "backlog-1", title: "Older backlog one", status: "backlog" },
      { id: "backlog-2", title: "Older backlog two", status: "backlog" },
    ] as Issue[];
    mocks.listCompact.mockImplementation(async (_company: string, filters: IssueListFilters) => {
      const filtered = filters.status ? tasks.filter((task) => filters.status!.split(",").includes(task.status)) : tasks;
      return filtered.slice(filters.offset ?? 0, (filters.offset ?? 0) + (filters.limit ?? 100));
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const settle = async () => {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    };
    try {
      await act(async () => {
        root.render(<QueryClientProvider client={client}><Issues /></QueryClientProvider>);
      });
      await settle();
      expect(container.textContent).toContain("Older backlog one");
      expect(container.textContent).toContain("Older backlog two");
      expect(container.textContent).toContain("Review task");
      expect(container.textContent).not.toContain("Done 0");
      expect(mocks.listCompact).toHaveBeenCalledTimes(1);
      expect(mocks.listCompact).toHaveBeenLastCalledWith("company-1", expect.objectContaining({
        status: "backlog,in_review", offset: 0,
      }), expect.anything());

      await act(async () => { container.querySelectorAll("button")[0].click(); });
      await settle();
      expect(container.textContent).toContain("Done 0");
      expect(container.textContent).not.toContain("Older backlog one");
      await act(async () => { container.querySelectorAll("button")[2].click(); });
      await settle();
      expect(mocks.listCompact).toHaveBeenLastCalledWith("company-1", expect.objectContaining({
        status: "done", offset: 100,
      }), expect.anything());

      await act(async () => { container.querySelectorAll("button")[1].click(); });
      await settle();
      expect(mocks.listCompact).toHaveBeenLastCalledWith("company-1", expect.objectContaining({
        status: undefined, offset: 0,
      }), expect.anything());
    } finally {
      await act(async () => root.unmount());
      client.clear();
      container.remove();
    }
  });
});
