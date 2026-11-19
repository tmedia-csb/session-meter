# Session meter

A Claude Code plugin that keeps one line above the prompt in every session:

```text
Been waiting 57s · Total waiting on you 57m · Claude thinking 40m · Total time 1h 37m      Stop
```

- **Been waiting:** how long Claude has been waiting on you since its last response. It counts to the second for three minutes, then by the minute. Your next prompt sets it back to zero.
- **Total waiting on you:** all the time Claude has spent waiting on you.
- **Claude thinking:** all the time Claude has spent working, from each prompt you send to the end of the response it starts. Work Claude starts on its own, such as after a background task finishes, counts here too.
- **Total time:** the count from your first prompt, leaving out any time it was stopped. Total waiting on you and Claude thinking add up to it.

## Stop and Start again

Click **Stop** on the line, or run `/stop-meter`, when you step away. The totals freeze and nothing runs. **Start again**, or your next prompt, picks the count up where it left off, and the time it was stopped isn't counted.

If you forget, the meter stops itself 30 minutes after Claude's last response with no prompt from you. Those 30 minutes count as waiting; the time after them doesn't.

A session the meter hasn't counted yet shows `Not started` with a **Start** button. `/clear` starts the count over.

## Install

In the Claude desktop app: click **+** next to the prompt box, then **Plugins**, then **Manage plugins**. Click **Add**, then **Add marketplace**, then **Add from a repository**. Enter `tmedia-csb/session-meter`, click **Sync**, then install **Session meter**. Adding a marketplace needs Git on your computer.

In a Claude Code session in the terminal, at the prompt (answer `y` to add the marketplace, then choose the user scope):

```text
/plugin install session-meter --marketplace tmedia-csb/session-meter
```

From a shell:

```bash
claude plugin install session-meter --marketplace tmedia-csb/session-meter
```

Start a new session after installing, and the line appears above the prompt there and in every session after.

## Notes

- Built and tested on Claude Code 2.1.321. It uses Claude Code's plugin hooks modules, so an older version may not run it.
- The desktop app and the terminal show the line. The mobile app doesn't.
- Everything stays on your computer. Each session's figures are saved in a file under `~/.claude/plugins/store/`, and the meter sends nothing anywhere.
- An open session picks up a new version of the plugin after `/reload-plugins`.
- To turn it off: `claude plugin disable session-meter@session-meter`.

## License

MIT
