# Connected apps

Connected apps (Gmail, GitHub, Slack, Calendar and hundreds more) run through Flux Router. One Flux Router key is all they need.

## Set up

1. Open **Settings → Models** and save your Flux Router key.
2. Open **Connected apps** and choose an app. Give each account a unique label such as `work` or `personal`, then finish the sign-in in your normal browser.
3. To add another account for the same app, choose **Add account** and give it its own label.

The Connected tab lists every account separately. **Disconnect** revokes only the account named on that row, and a new sign-in never silently replaces an existing connection. Each app is capped at five usable accounts.

## If you used a key of your own before

Connected apps no longer use a key you saved yourself. Your saved value is kept, untouched, but nothing reads or sends it. Add your Flux Router key and connect your apps again from the Connected apps page.

## Running from source

A source build uses Flux Router the same way: save the Flux Router key in Models. There is no separate connected-apps key or environment variable.
