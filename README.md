# Nodeforge

Repository for the Nodeforge project.

## Development

The root workspace command starts all development processes with labelled logs:

```sh
pnpm dev
```

This runs the Control API (`:3100`), the filesystem Watcher/Code Index, and the
Next.js UI. The legacy Vite app remains available separately with
`pnpm dev:web` until the Next.js replacement is approved.
