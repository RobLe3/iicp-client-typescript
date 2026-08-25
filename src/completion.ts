const COMMANDS = ["completion", "credits", "doctor", "healthcheck", "help", "init", "list", "mcp-gateway", "operator", "proxy", "query", "serve", "service", "update"];
const SUBCOMMANDS: Record<string, string[]> = {
  operator: ["decrypt", "dsr", "encrypt", "key", "rename"],
  "operator dsr": ["anonymize", "export", "restrict"],
  "operator key": ["export", "generate", "import", "list", "revoke", "rotate"],
  service: ["install", "restart", "status", "uninstall"],
};
const OPTIONS: Record<string, string[]> = {
  "": ["--help", "--version"],
  query: ["--directory-url", "--intent", "--json", "--node", "--routing-profile"],
  serve: ["--backend-type", "--directory-url", "--host", "--node", "--port", "--routing-profile"],
};
const VALUES: Record<string, string[]> = {
  "query --routing-profile": ["eu-restricted", "sensitive", "standard", "strict-policy"],
  "serve --backend-type": ["anthropic", "llamacpp", "meshllm", "openai_compat", "vllm"],
};
export function completionCandidates(tokens: string[]): string[] {
  if (!tokens.length) return [...COMMANDS];
  const partial = tokens.at(-1) ?? "";
  const prior = tokens.slice(0, -1);
  const command = prior[0] ?? "";
  const values = VALUES[`${command} ${prior.at(-1) ?? ""}`];
  if (values) return values.filter((v) => v.startsWith(partial));
  const path = prior.filter((v) => v && !v.startsWith("-")).join(" ");
  let choices = prior.length ? [...(SUBCOMMANDS[path] ?? [])] : [...COMMANDS];
  if (partial.startsWith("-")) choices = [...(OPTIONS[command] ?? []), ...OPTIONS[""]];
  return [...new Set(choices.filter((v) => v.startsWith(partial)))].sort();
}
export function completionScript(input: string): string {
  const shell = input === "pwsh" ? "powershell" : input;
  const scripts: Record<string, string> = {
    bash: `_iicp_node_complete() {\n  COMPREPLY=()\n  local -a args=("\${COMP_WORDS[@]:1:$COMP_CWORD}")\n  while IFS= read -r candidate; do COMPREPLY+=("$candidate"); done < <(command iicp-node __complete "\${args[@]}")\n}\ncomplete -F _iicp_node_complete iicp-node\n`,
    zsh: `_iicp_node_complete() {\n  local -a args candidates\n  args=("\${words[@]:1}")\n  candidates=("\${(@f)$(command iicp-node __complete "\${args[@]}")}")\n  compadd -- $candidates\n}\ncompdef _iicp_node_complete iicp-node\n`,
    fish: `function __iicp_node_complete\n  set -l tokens (commandline -opc)\n  set -e tokens[1]\n  set -a tokens (commandline -ct)\n  command iicp-node __complete $tokens\nend\ncomplete -c iicp-node -f -a '(__iicp_node_complete)'\n`,
    powershell: `Register-ArgumentCompleter -Native -CommandName iicp-node -ScriptBlock {\n  param($wordToComplete, $commandAst, $cursorPosition)\n  $tokens = @($commandAst.CommandElements | Select-Object -Skip 1 | ForEach-Object { $_.Extent.Text })\n  if ($tokens.Count -eq 0 -or $commandAst.Extent.Text.EndsWith(' ')) { $tokens += '' }\n  iicp-node __complete @tokens | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) }\n}\n`,
  };
  if (!scripts[shell]) throw new Error(`unsupported shell: ${input}`);
  return scripts[shell];
}
