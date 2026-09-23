"use client";

import {
  useState,
} from "react";
import {
  ChatApp,
} from "./chat-app";
import {
  SearchApp,
} from "./search-app";

export function WorkspaceApp() {
  const [mode, setMode] =
    useState<
      "ask" | "search"
    >("ask");

  return (
    <>
      <div className="workspace-switch">
        <button
          type="button"
          className={
            mode === "ask"
              ? "workspace-switch-button active"
              : "workspace-switch-button"
          }
          onClick={() =>
            setMode("ask")
          }
        >
          Ask
        </button>

        <button
          type="button"
          className={
            mode === "search"
              ? "workspace-switch-button active"
              : "workspace-switch-button"
          }
          onClick={() =>
            setMode("search")
          }
        >
          Search
        </button>
      </div>

      {mode === "ask" ? (
        <ChatApp />
      ) : (
        <SearchApp />
      )}
    </>
  );
}
