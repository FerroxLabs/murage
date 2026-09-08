# Telegram control in Murage

Murage 0.1.47 connects a paired owner's private Telegram chat to the Chief of Staff's current conversation. It is a way to continue the same work from your phone while Murage remains running on its host.

## Connect your bot

1. In Telegram, open the official [BotFather](https://t.me/BotFather), send `/newbot` and follow its prompts. Keep the resulting token private. Telegram's [bot creation guide](https://core.telegram.org/bots/features#botfather) explains the process.
2. In Murage, open **Settings → Channels → Telegram**. Save your bot token. The desktop stores it encrypted on that computer; the settings screen does not show it again.
3. Choose **Pair with Chief**, then copy the pairing command.
4. Send that command to your new bot in a **private Telegram chat** before it expires. The setup screen updates while pairing.
5. Once Paired appears, send a normal message. Its reply and history belong to the Chief's current Murage conversation.

Keep Murage running. **Pair again after restarting Murage.** Use Revoke in Settings to disconnect; revoke before replacing the token. If Telegram delivery is reported as uncertain, inspect the Telegram chat before sending the same work again.

## Approvals

The paired owner can answer supported ordinary tool requests with one-time **Allow once** or **Deny** buttons. The binding checks the sender and chat. Typing “approve”, “yes” or a similar message does not grant permission.

Richer proposal reviews remain in the desktop app. Pairing Telegram does not grant remote workspace-memory administration or unrestricted desktop management.

## Scope in this release

- One paired private-owner connection, targeting the configured Chief/current conversation.
- No Telegram group routing or independent group/team destinations.
- No shipped Slack, Discord or WhatsApp control channels.
- No always-on hosted relay that keeps your local agents running after the host stops.

Internal Murage team channels are separate: they coordinate selected agents inside the app. A service being available as an agent's connected tool also does not make it a supported inbound control channel.
