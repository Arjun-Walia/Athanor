// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Menu, MenuItem, ReplicaDot, StatusBadge, Toasts } from "./components.jsx";
import { afterEach } from "vitest";

afterEach(cleanup);

describe("StatusBadge and ReplicaDot", () => {
  it("say the state in words, not only colour", () => {
    render(<StatusBadge status="suspect" partitioned />);
    expect(screen.getByText("Suspect")).toBeTruthy();
    expect(screen.getByText(/cut/)).toBeTruthy();
    render(<ReplicaDot replica={{ node: "node2", status: "hint", hint_for: "node3" }} />);
    expect(screen.getByText("node2: Hint parked for node3")).toBeTruthy();
  });
});

describe("Menu", () => {
  function Subject({ onPick }) {
    return (
      <Menu label="Actions" icon="More">
        <MenuItem onSelect={() => onPick("a")}>First</MenuItem>
        <MenuItem onSelect={() => onPick("b")}>Second</MenuItem>
      </Menu>
    );
  }

  it("opens on click, moves focus with the arrow keys, and closes on Escape back to the button", async () => {
    vi.useFakeTimers();
    render(<Subject onPick={() => {}} />);
    const button = screen.getByRole("button", { name: "Actions" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    await act(async () => {
      vi.runAllTimers();
    });
    const items = screen.getAllByRole("menuitem");
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "End" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(button);
    vi.useRealTimers();
  });

  it("closes after an item is chosen", () => {
    const picked = [];
    render(<Subject onPick={(v) => picked.push(v)} />);
    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    fireEvent.click(screen.getByText("Second"));
    expect(picked).toEqual(["b"]);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("Toasts", () => {
  it("renders each message and reports a dismissal", () => {
    const dismissed = [];
    render(<Toasts items={[{ id: 1, tone: "ok", text: "Stored it." }]} onDismiss={(id) => dismissed.push(id)} />);
    expect(screen.getByText("Stored it.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(dismissed).toEqual([1]);
  });
});
