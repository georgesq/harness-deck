# Task — harness em qualquer rota de LLM

Acompanhamento de [spec-feat-provider-route.md](spec-feat-provider-route.md).
Cada item marcado aponta a prova; item sem prova fica desmarcado, mesmo que o código exista.

Legenda: `[x]` feito e verificado · `[~]` código pronto, falta a prova combinada · `[ ]` pendente.

| | Requisito | Onde | Prova |
| --- | --- | --- | --- |
| [x] | REQ-R1 — rota não é conjunto fechado | `launcher/src/registry.ts` (`HarnessProvider.kind: string`) | `registry.ts` (`normalizeProvider`); `add.test.ts`: rota de catálogo, rota local, rota própria |
| [x] | REQ-R2 — atalhos por rota do catálogo | `registry.ts` (`PROVIDER_ROUTES`, `PROVIDER_BASE_URLS`, `PROVIDER_KEY_ENV`) | `add.test.ts`: `anthropic` vem com `ANTHROPIC_API_KEY` e `https://api.anthropic.com` |
| [x] | REQ-R3 — protocolo de fio por rota | `registry.ts` (`providerApi`), `materialize.ts` (`profilePatchYml` emite `api:`) | `add.test.ts`: o patch do gateway carrega `api: openai-completions` |
| [x] | REQ-R4 — rota desconhecida exige `--base-url` e `--api` | `cli.ts` (chama `normalizeProvider` antes de gravar) | `add.test.ts`: aceita com os dois, recusa sem eles com a mensagem que nomeia o campo |
| [x] | REQ-R5 — endpoint local sem chave | `registry.ts` (`providerKeyEnv` → `LLM_API_KEY`) | `add.test.ts`: `ollama` aceito com `apiKeyEnv: LLM_API_KEY` |
| [x] | REQ-R6 — trocar de rota não deixa rastro | `cli.ts` (`switched`), `materialize.ts` (`mergeProviderRoute`, `providerOf`) | `merge-patch.test.ts`: 4 casos; mutação das duas guardas faz 3 falharem. Ciclo real `openrouter`→`ollama`: `grep -c openrouter` = 0 |
| [x] | REQ-R7 — painel e CLI leem o mesmo contrato | `sync-shared.mjs`, `src/shared/registry.ts`, `vscode/src/registry.ts` (shim) | `shared-copy.test.ts` (2 verificações) falha se qualquer cópia divergir |
| [x] | REQ-R8 — CLI estrito, painel tolerante | `registry.ts` (`normalizeRegistry`) vs `vscode/src/registry.ts` (`loadRegistry`) | `stopall.test.mjs`, `lifecycle.test.mjs`; `loadRegistry` mantém a filtragem por entrada |

## Pendente do dono

- [ ] REQ-R3 provado no fio: subir um harness numa rota não-OpenRouter (ex.: `anthropic` ou um gateway
      interno) e completar uma mensagem de verdade. A prova acima é do patch materializado, não de um
      request completo.
