import {
  renderLegacyBrowserInteractionSection,
  renderLegacyBrowserLifecycleSection,
  renderLegacyBrowserPollingSection,
  renderLegacyBrowserSetupSection,
  renderLegacyBrowserTransportSection,
  renderLegacyBrowserUtilitySection,
} from './legacy-browser-script-sections.js';

export function renderLegacyBrowserAttachScript(options: {
  attachPath: string;
  refreshMs: number;
}) {
  return [
    renderLegacyBrowserSetupSection(options),
    renderLegacyBrowserUtilitySection(),
    renderLegacyBrowserTransportSection(),
    renderLegacyBrowserPollingSection(),
    renderLegacyBrowserInteractionSection(),
    renderLegacyBrowserLifecycleSection(),
  ].join('\n');
}
