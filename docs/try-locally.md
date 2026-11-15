# Try context-hub on your own computer

This is for seeing the hub work before you rent a server. It runs on your own computer, with no domain and no certificate. It has two limits. The hub can only be reached from this computer, and claude.ai, the Claude desktop chat and the mobile apps cannot connect to it. You read it from Claude Code instead.

## Start the hub

You need Docker.

```bash
docker run -d --name context-hub -p 127.0.0.1:3000:3000 -v context_hub_data:/data -e PUBLIC_URL=http://localhost:3000 ghcr.io/abdulmuhg/context-hub:latest
```

## Get your codes

```bash
docker exec context-hub hub-admin setup
```

It prints two things: a sign-in code for the dashboard, and an install line for each kind of computer, with a one-use code inside. Both codes work for 10 minutes.

Open `http://localhost:3000/login` and sign in with the sign-in code. Then paste the install line for your system into a terminal on this computer. It needs Node 22 or newer.

## Read it from Claude Code

Create a read token:

```bash
docker exec context-hub hub-admin token create --label claude-code --scope read
```

It is shown once. Add the hub to Claude Code, with the token in place of `<the token>`:

```bash
claude mcp add --transport http context-hub http://localhost:3000/mcp --header "Authorization: Bearer <the token>"
```

Then ask "where did we leave off on <project>?" in a new Claude Code session.

## Moving to a real server later

Follow the quick start in the [README](../README.md) on the server, then paste the new hub's install line on this computer. `hub sync` uploads the same sessions again. The [deploy guide](../deploy/README.md) has the details.

## Remove it

```bash
docker rm -f context-hub
docker volume rm context_hub_data
```
