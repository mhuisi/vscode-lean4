## Installed Components
The following components are automatically installed when clicking [this link](command:lean4.setup.installLean) or the 'Install Lean' button associated with this step:
- [Elan](https://github.com/leanprover/elan) is Lean's version manager and automatically manages all the different versions of Lean and ensures that the correct version is used when opening a project.
- [Git](https://git-scm.com/) is a commonly used [Version Control System](https://en.wikipedia.org/wiki/Version_control) that is used by Lean to help manage different versions of Lean formalization packages and software packages. It can also be used to collaborate on Lean projects.
- [curl](https://curl.se/) is a small tool to transfer data that is used by Lean to download files when managing Lean formalization packages and software packages.

Components that are already installed will be skipped.

## Installation Procedure Details
The automatic installation will run a script to install Elan, Git and curl. To install Git and curl using your package manager, it needs admin privileges, the credentials for which it will prompt for during the installation.

On Linux systems that support the package manager `apt` (e.g. Debian or Ubuntu), the following script will be executed:
```bash
# Install Git and curl. `pkexec` is used to display a secure graphical input for your credentials.
ulimit -Sn 1024; pkexec bash -c 'export DEBIAN_FRONTEND=noninteractive; apt-get update -y && apt-get install -y git curl'
# Download the Elan installation script at https://github.com/leanprover/elan/blob/master/elan-init.sh using `curl` and run it using `sh`. Elan will be installed to `~/.elan`.
# `set -o pipefail` makes the installation fail if the download fails.
set -o pipefail
curl "https://elan.lean-lang.org/elan-init.sh" -sSf | sh -s -- -y --default-toolchain leanprover/lean4:stable
```

On Linux systems that support the package manager `dnf` (e.g. Fedora), the following script will be executed:
```bash
# Install Git and curl. `pkexec` is used to display a secure graphical input for your credentials.
pkexec dnf install -y git curl
# Download the Elan installation script at https://github.com/leanprover/elan/blob/master/elan-init.sh using `curl` and run it using `sh`. Elan will be installed to `~/.elan`.
# `set -o pipefail` makes the installation fail if the download fails.
set -o pipefail
curl "https://elan.lean-lang.org/elan-init.sh" -sSf | sh -s -- -y --default-toolchain leanprover/lean4:stable
```

On Linux systems that do not support either of the package managers `apt` and `dnf`, Git and curl cannot be installed automatically. 
If you do not have them installed yet, please install Git and curl using your system's package manager, restart VS Code and re-try this step - once Git and curl are installed, Lean's version manager Elan can be installed using the automatic installation script.

## Restricted Environments
If you are in a restricted environment where you cannot install Git or curl and they are not already installed, for example a restricted university computer, then the installation script above may fail. In this case, there is currently no way to try Lean 4 with a local installation. If you want to try out Lean 4 regardless, you can read [Mathematics in Lean](https://leanprover-community.github.io/mathematics_in_lean/) and do the exercises with [an online instance of Lean 4 hosted using Gitpod](https://gitpod.io/#/https://github.com/leanprover-community/mathematics_in_lean). Doing so requires creating a GitHub account. Alternatively, you can also [play the Natural Number Game](https://adam.math.hhu.de/#/g/hhu-adam/NNG4) or [try a single-file version of Lean 4 in your web browser](https://live.lean-lang.org/).
