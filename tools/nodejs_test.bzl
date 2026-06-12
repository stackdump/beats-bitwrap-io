"""A minimal `nodejs_test` rule on top of the rules_nodejs hermetic toolchain.

rules_nodejs 6.x ships only the Node.js toolchain (no nodejs_test/js_test — those
moved to aspect_rules_js, which is npm-lockfile oriented and the wrong fit for
beats' no-npm vanilla ES modules). This rule just runs `node <entry_point>` with
the hermetic node, staging `data` into runfiles. Relative ESM imports in the
entry script resolve against the script's own location in the runfiles tree.
"""

def _nodejs_test_impl(ctx):
    toolchain = ctx.toolchains["@rules_nodejs//nodejs:toolchain_type"]
    node = toolchain.nodeinfo.node
    entry = ctx.file.entry_point

    launcher = ctx.actions.declare_file(ctx.label.name + ".sh")
    ctx.actions.write(
        output = launcher,
        is_executable = True,
        content = """#!/usr/bin/env bash
set -euo pipefail
# bazel test sets cwd to the runfiles root of the main repo; short_paths are
# resolved relative to it (external repos sit one level up at ../).
exec "{node}" "{entry}" "$@"
""".format(node = node.short_path, entry = entry.short_path),
    )

    runfiles = ctx.runfiles(files = [entry] + ctx.files.data)
    runfiles = runfiles.merge(toolchain.default.default_runfiles)

    return [DefaultInfo(executable = launcher, runfiles = runfiles)]

nodejs_test = rule(
    implementation = _nodejs_test_impl,
    test = True,
    attrs = {
        "entry_point": attr.label(allow_single_file = True, mandatory = True),
        "data": attr.label_list(allow_files = True),
    },
    toolchains = ["@rules_nodejs//nodejs:toolchain_type"],
)
