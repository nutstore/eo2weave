# Extension skills

Each child directory is a skill package with a `SKILL.md` file. Supported text
resources (Markdown, scripts, JSON, YAML, HTML, CSS, CSV, SVG, and plain text)
are bundled with the extension, using the same release version as its features.

The extension publishes a read-only `extension-skills` filesystem provider on
trusted CreatorWeave pages. Its declared `skillRoots: ['']` lets the Web app
discover packages without knowing their names. Files can be read at:

`vfs://external/extension-skills/<directory>/SKILL.md`

The Web app keeps provider skills in memory, refreshes availability on provider
registration, every five seconds, and before collecting Agent skill context.
Instructions and resources are read from the provider when requested. Provider
identity and package directory form the stable skill ID; same-name packages
remain distinct. The enabled preference is saved locally, while package content
stays in the extension. No installation or migration into OPFS is required.

`cw-webmcp-creator` is available whenever the extension provider is connected:
it helps create and configure adapters, including before any adapter is enabled.
