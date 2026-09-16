// FRACTAL: implements F1 | component C10
'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { getHealth } from '@/ui/api-client';
import { providerName, type HealthView } from '@/shapes';

export const CLI_MISSING_LABEL =
  "The AI helper isn't installed yet. Install the Claude command-line tool, then try again.";

/**
 * WHY this is not one fixed sentence: the helper the app needs is whichever provider the
 * learner chose, and the probe already knows how to repair that one ("run `ollama pull`").
 * Telling somebody who runs Ollama to install the Claude CLI is advice about software
 * they deliberately did not choose, on every page.
 */
export function cliMissingLabel(health: HealthView): string {
  if (health.cli.message !== null && health.cli.message !== '') return health.cli.message;
  if (health.provider === 'claude') return CLI_MISSING_LABEL;
  const name = providerName(health.provider);
  const model = health.providerModel;
  return model === null || model === ''
    ? `The AI helper isn't ready yet. Check that ${name} is running, then try again.`
    : `The AI helper isn't ready yet. Check that ${name} is running with ${model}, then try again.`;
}

/**
 * WHY this is all that is left up here: the app no longer asks permission before spending —
 * pressing a control IS the authorisation. What the learner still cannot know by looking is
 * whether the helper this machine needs is installed at all, so that one fact stays on every
 * page. It says nothing while the helper is present, and nothing before the answer arrives.
 */
export function AppCliBanner(): ReactNode {
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    void getHealth().then((response) => {
      if (!response.ok) return;
      setLabel(response.data.cli.available ? null : cliMissingLabel(response.data));
    });
  }, []);

  if (label === null) return null;

  return (
    <p className="la-warn" role="status" data-testid="cli-banner">
      {label}
    </p>
  );
}
