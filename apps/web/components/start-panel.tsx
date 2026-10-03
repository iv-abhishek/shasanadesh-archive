"use client";

/**
 * Start page of Ask (ADR-060).
 *
 * Ask does three things (ADR-057/058): answer questions from the order text,
 * find particular orders, and list the latest or dated orders. The start page
 * shows one card per job with ready examples. Examples fill the input box so
 * they can be edited before sending. (The search-syntax guide was removed on
 * 3 Oct 2026; the syntax itself still works.)
 */

import type { ReactNode } from "react";

type Pick = (text: string) => void;

interface Task {
  key: string;
  title: string;
  titleHi: string;
  description: string;
  examples: string[];
  icon: ReactNode;
}

const TASKS: Task[] = [
  {
    key: "ask",
    title: "Ask a question",
    titleHi: "प्रश्न पूछें",
    description: "Rules, procedures, eligibility and limits, answered from the order text with the page it comes from.",
    examples: ["सोलर पंप लगवाने हेतु क्या प्रक्रिया है?", "What are the seniority rules for medical officers?"],
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 5h14v10H9l-4 4z" />
        <path d="M9 9h6M9 12h4" />
      </svg>
    ),
  },
  {
    key: "find",
    title: "Find an order",
    titleHi: "शासनादेश खोजें",
    description: "By GO number, subject words, an exact phrase, a wildcard or the issuing section.",
    examples: ["find GO 51/2026", "orders about farmer registry", "\"समयपूर्व रिहाई\" वाले शासनादेश"],
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="11" cy="11" r="6" />
        <path d="m20 20-4.5-4.5" />
      </svg>
    ),
  },
  {
    key: "latest",
    title: "Latest and dated orders",
    titleHi: "नवीनतम शासनादेश",
    description: "What a department issued today, this week, in a month or on a given date.",
    examples: ["Recent orders of Public Works Department", "10 या 15 सितम्बर के कृषि विभाग के शासनादेश", "orders issued this week"],
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="4" y="5" width="16" height="15" rx="2" />
        <path d="M4 10h16M9 3v4M15 3v4" />
      </svg>
    ),
  },
];

export function StartPanel({ onPick }: { onPick: Pick }) {
  return (
    <section className="start-panel" aria-label="Getting started">
      <div className="start-hero">
        <h2>Ask about UP government orders, or find one.</h2>
        <p className="start-hero-hi" lang="hi">
          शासनादेशों के बारे में प्रश्न पूछें या कोई शासनादेश खोजें।
        </p>
        <p>
          Answers quote the exact page they rely on. Orders can be found by number, subject, department, issuing section
          or date, in English or Hindi.
        </p>
      </div>

      <div className="start-tasks">
        {TASKS.map((task) => (
          <article className="start-task" key={task.key}>
            <div className="start-task-head">
              <span className="start-task-icon">{task.icon}</span>
              <div>
                <h3>{task.title}</h3>
                <span lang="hi">{task.titleHi}</span>
              </div>
            </div>
            <p>{task.description}</p>
            <ul>
              {task.examples.map((example) => (
                <li key={example}>
                  <button type="button" onClick={() => onPick(example)}>
                    <span>{example}</span>
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M5 12h13m-5-5 5 5-5 5" />
                    </svg>
                  </button>
                </li>
              ))}
            </ul>
          </article>
        ))}
      </div>
    </section>
  );
}
