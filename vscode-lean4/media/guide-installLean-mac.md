## Installed Components
The following components are automatically installed when clicking [this link](command:lean4.setup.installLean) or the 'Install Lean' button associated with this step:
- [Elan](https://github.com/leanprover/elan) is Lean's version manager and automatically manages all the different versions of Lean and ensures that the correct version is used when opening a project.
- [Apple Command Line Tools](https://developer.apple.com/xcode/resources/) (also known as 'Xcode Command Line Tools') includes several utility tools that are useful for working with a programming language. Lean in particular needs [Git](https://git-scm.com/) from Apple Command Line Tools, a commonly used [Version Control System](https://en.wikipedia.org/wiki/Version_control) that is used by Lean to help manage different versions of Lean formalization packages and software packages. Git can also be used to collaborate on Lean projects.

Components that are already installed will be skipped.

## Installation Procedure Details
The automatic installation will run the following script to install Elan and Apple Command Line Tools:
```bash
# Stop at the first command that fails.
set -e
# Install Apple Command Line Tools using `softwareupdate`.
touch "/tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress"
aclt_label="$(/usr/sbin/softwareupdate -l |
              grep -B 1 -E 'Command Line Tools' |
              awk -F'*' '/^ *\*/ {print $2}' |
              sed -e 's/^ *Label: //' -e 's/^ *//' |
              sort -V |
              tail -n1 |
              tr -d '\n')"
/usr/sbin/softwareupdate -i "$aclt_label"
# Download the Elan installation script at https://github.com/leanprover/elan/blob/master/elan-init.sh using `curl` and run it using `sh`. Elan will be installed to `~/.elan`.
# `set -o pipefail` makes the installation fail if the download fails.
set -o pipefail
curl "https://elan.lean-lang.org/elan-init.sh" -sSf | sh -s -- -y --default-toolchain leanprover/lean4:stable
```

## Restricted Environments
If you are in a restricted environment where you cannot install Git or curl and they are not already installed, for example a restricted university computer, then the installation script above may fail. In this case, there is currently no way to try Lean 4 with a local installation. If you want to try out Lean 4 regardless, you can read [Mathematics in Lean](https://leanprover-community.github.io/mathematics_in_lean/) and do the exercises with [an online instance of Lean 4 hosted using Gitpod](https://gitpod.io/#/https://github.com/leanprover-community/mathematics_in_lean). Doing so requires creating a GitHub account. Alternatively, you can also [play the Natural Number Game](https://adam.math.hhu.de/#/g/hhu-adam/NNG4) or [try a single-file version of Lean 4 in your web browser](https://live.lean-lang.org/).
