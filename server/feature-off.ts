// Capability settings are independent of saved permission decisions.
export const CONNECTED_APPS_OFF='Connected apps are disabled (off) for this bot. Turn them on in the bot’s Connected apps settings.';
export function featureOffLine(tool: string, settings: {browser?: boolean; computer?: string; composio?: boolean; noLimits?: boolean; fullAccessChannelMessages?: boolean}, browserEnabled = true, origin?: string): string | undefined {
 if(origin==='owner-channel'&&settings.fullAccessChannelMessages===false)return 'Channel messages are off for this bot. Turn them on in the bot’s Permissions settings.';
 const name=tool.replace(/^mcp__/, '');
 if ((!browserEnabled || settings.browser === false) && /^(?:agent_browser_|browser(?:__|_))/i.test(name)) return 'Browser control is off. Turn it on in the bot’s Browser settings.';
 if (settings.computer === 'off' && /^(?:host_computer|computer(?:__|_)|local_computer_consent)/i.test(name)) return 'Computer control is off. Turn it on in the bot’s Computer settings.';
 if (settings.composio === false && /^(?:COMPOSIO_|APPS_|murage_connectors(?:__|_)|composio(?:__|_))/i.test(name)) return CONNECTED_APPS_OFF;
 return undefined;
}
