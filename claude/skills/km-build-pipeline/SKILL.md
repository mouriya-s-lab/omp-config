---
name: km-build-pipeline
description: >-
  Inspect and run Komodo Build or Repo resources: image builds, Periphery clone/pull/build, cancellation and asynchronous results. Use for an explicit Komodo build path; existing GitHub Actions/GARM pipelines belong to local-cicd.
allowed-tools: Bash, Read
---

# Komodo Build and Repo workflows

A **Build** produces an image; a **Repo** manages a checkout and configured build commands on a Periphery host. Neither is interchangeable with a source repository's GitHub Actions workflow. Select the Core through `skill://container-management`; profile recovery is `skill://km-endpoints`.

## Find the existing pipeline

```bash
core=homelab
km -p "$core" ls builds -f json
km -p "$core" ls repos -f json
```

Inspect the chosen resource's full configuration in Komodo: source repo/branch, builder or Server, commands, artifact/image destination, credentials path and downstream triggers. If the inventory is empty or the project already builds through GitHub Actions on GARM/vctcn-runner, use `skill://local-cicd`. Do not create a parallel Komodo pipeline merely because this skill was selected.

Durable config changes belong to the resource's declaration owner. Resolve it before changing branches/commands; an ad hoc `km update build` is not a substitute for its repo/IaC workflow. Build or Repo commands may deploy or mutate external systems, so inspect their actual effects and authorization before running.

## Run the selected operation

Set `build` or `repo` to the exact resource name discovered above. Choose one operation appropriate to current state:

```bash
km -p "$core" x run-build "$build"
km -p "$core" x clone-repo "$repo"
km -p "$core" x pull-repo "$repo"
km -p "$core" x build-repo "$repo"
```

A Repo clone/pull updates the host checkout; it is not proof the configured build ran or an image was published. Check existing checkout state and configured commands before deciding which step is needed. Do not wildcard-run unrelated resources.

## Follow the asynchronous result

A build execution can return before completion. Capture its execution/update reference and inspect the terminal status and logs in Komodo. These listings help find active work:

```bash
km -p "$core" ls builds --in-progress
km -p "$core" ls repos --in-progress
```

Disappearing from `--in-progress` is **not** proof of success: inspect the execution's final result. Verify the built source revision and actual published image/tag/digest or Repo output. If deployment is part of the request, follow the configured deployment path and verify the real application behavior; a successful build alone does not close that task.

## Cancel or recover

```bash
km -p "$core" x cancel-build "$build"
km -p "$core" x cancel-repo-build "$repo"
```

Cancel only the intended active execution. Check terminal cancellation and any partially produced artifacts or completed side effects before retrying; cancellation does not roll those back. If a build fails, inspect logs and fix its owning source/config/credential path, then rerun the affected build. Do not create duplicate builds while one is still active, change image tags to hide a failure or claim the previous output came from the failed revision.
