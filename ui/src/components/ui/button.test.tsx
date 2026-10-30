// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { buttonVariants } from "./button";

describe("buttonVariants", () => {
  it("gives an active outline toggle its own background in light and dark themes", () => {
    const classes = buttonVariants({ variant: "outline" }).split(" ");

    // `dark:bg-input/30` would otherwise hide a plain `bg-accent` on an active toggle in the dark theme.
    expect(classes).toContain("data-[active=true]:bg-accent");
    expect(classes).toContain("dark:data-[active=true]:bg-input");
    expect(classes).toContain("data-[active=true]:border-foreground/30");
  });
});
