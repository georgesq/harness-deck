# Task — parar de verdade e enviar de verdade

Acompanhamento da implementação de [spec-feat-parar-e-enviar.md](spec-feat-parar-e-enviar.md).
Cada item marcado aponta a prova; item sem prova fica desmarcado, mesmo que o código exista.
Branch desta frente: **`feat/model-list-and-tool-approval`** (18 commits até `a83a43a`).

Legenda: `[x]` feito e verificado · `[~]` código pronto, falta a prova combinada · `[ ]` pendente.

---

## 1. Parada (problema 1) — fechado

| | Requisito | Onde | Prova |
| --- | --- | --- | --- |
| [x] | REQ-P1 — parar vale para harness subido por qualquer via | `launcher/src/process.ts` (`stopProcess`) | `stop.test.ts` caso 1; ciclo real `up`→`down` com o DSH de verdade |
| [x] | REQ-P2 — só diz "parado" com porta fechada **e** pid morto | `process.ts` (veredito duplo) | `stop.test.ts` caso 6; `lifecycle.test.mjs` caso 6 |
| [x] | REQ-P3 — pid file morto + porta viva: acha o dono, não mente | `process.ts` (`findPortOwner`) | `stop.test.ts` caso 2; `lifecycle.test.mjs` caso 5 |
| [x] | REQ-P4 — um caminho só de parada para CLI e painel | `sync-shared.mjs` + `shared/process.ts` | `shared-copy.test.ts` falha se divergirem |
| [x] | REQ-P5 — um caminho só de subida (`detached`, pid, log) | `launcher/src/launcher.ts` | `lifecycle.test.mjs` caso 2 |
| [x] | REQ-P6 — o resultado da parada aparece na tela | `extension.ts` (`stopReport` + notificação) | `notify.test.mjs`: `parou (SIGTERM)`, `parou (SIGKILL)`, `nao parou: porta N (pid M)`, nada-a-parar — os três pelo `activate` real com o host dublado. **Faltava isto:** a parada bem-sucedida só ia para o canal de saída, nunca para notificação |

## 2. Close não deixa nada rodando (problema 3) — fechado

| | Requisito | Onde | Prova |
| --- | --- | --- | --- |
| [x] | REQ-L1 — fechar mata processo **e** filhos | `process.ts` (`killTree`) + `extension.ts` (`deactivate`) | `lifecycle.test.mjs` caso 1 |
| [x] | REQ-L2 — orçamento com SIGKILL no fim | `waitForStopped` + `DEACTIVATE_BUDGET_MS` | `stop.test.ts` caso 4; `lifecycle.test.mjs` caso 4 |
| [x] | REQ-L4 — sem pid file, a porta revela o dono | `findPortOwner` (lsof → fuser) | `stop.test.ts` caso 8; `lifecycle.test.mjs` caso 3 |
| [x] | REQ-L5 — raiz somente leitura não derruba a parada | `removePidFile` best-effort + aviso | `stop.test.ts` caso 7 |
| [x] | REQ-L7 — quem decide é a porta, não `kill(pid, 0)` | `portListening` no veredito | todos os casos de parada |
| [x] | REQ-L8 — mata a árvore, não só o processo do harness | `killTree` (`-pid`) | `stop.test.ts` caso 5; `lifecycle.test.mjs` caso 1 |
| [x] | REQ-L3 — `deactivate` avisa os sobreviventes | `extension.ts` (`survivorWarning`) | `notify.test.mjs`: `deactivate` real não inventa aviso sem sobrevivente; a mensagem nomeia cada um |

## 3. Mensagem no pool (problema 2) — fechado

Suíte da ponte verde: **12 verificações** no laço e **7** no controle ACP. `tsc --noEmit` limpo.

| | Requisito | Onde | Prova |
| --- | --- | --- | --- |
| [x] | REQ-M1 — a mensagem aparece na trajetória no instante do envio (caminho `steer`) | `bridge-loop.ts` | `bridge-loop.test.ts`: `user/message` antes do `turn/end`; no envio, o registro durável é o `agent/inbox/spliced`, que o acumulador do cliente lê (`dsh-api-session-controller/lib/types/client/sessions/session.js:679`) |
| [x] | REQ-M2 — consome `next-step` na fronteira do passo | `bridge-loop.ts` | `bridge-loop.test.ts`: steer no meio do passo vira o passo 2 do mesmo turno |
| [x] | REQ-M3 — `steer` e `followup` como no motor padrão | `bridge-loop.ts` | `bridge-loop.test.ts`: followup abre turno próprio depois do `turn/end`; com `busyEnter: queue` (padrão) o followup entra na trajetória na abertura do turno seguinte, igual ao motor padrão |
| [x] | REQ-M3b — com `busyEnter: steer`, a espera encurta de fato | `acp-control.ts` (`_session/steering`) | `acp-control.test.ts`: só injeta se o agente anuncia `_meta.steering.supported` |
| [x] | REQ-M4 — cancelar aborta o prompt ACP de verdade | `acp-control.ts` (`session/cancel`) | `acp-control.test.ts`: `session/cancel` cruza o fio, `$/cancel_request` não aparece |
| [x] | REQ-M5 — turno que não termina não trava a fila | `bridge-loop.ts` (timeout) | `bridge-loop.test.ts`: turno mudo fecha com erro visível e destrava |
| [x] | REQ-M6 — nada de histórico inventado, ordem válida | `bridge-loop.ts` | `bridge-loop.test.ts`: mensagem entra uma vez, revisões consecutivas |
| [x] | `tsc --noEmit` na ponte e suíte fechada no `npm test` | limpo; 12 + 7 verificações |
| [x] | Commit por caminho | `f618ebb`, `4ac6944`, `27368db` |

### 3.1 Ressalvas do implementador (não são requisito, mas ficam registradas)

- **Premissa da spec corrigida.** A spec dizia que "o evento durável já é feito pelo DSH antes de
  chegar ao agente". É falso: `dsh-api-session-controller/lib/index.js:882-883` só chama
  `agent.steer`/`agent.followup` e nunca anexa `user/message`. Quem grava o registro durável é o
  inbox do motor — por isso a ponte grava `agent/inbox/spliced` via `session.append`
  (`Session.append` existe em `dsh-session/lib/types/index.d.ts:246`). Verificado nesta sessão.
- **Notificações `agent/inbox/inserted|claimed|discarded` não emitidas.** O motor padrão emite
  (`dsh-agent-loop/lib/index.js:106,205-206`); a ponte não. Consumidores possíveis:
  `dsh-goal-round-driver`, `dsh-subagent`, `dsh-user-questions`, `dsh-acp`. Se algum está ativo
  neste perfil e depende do aviso: **não localizado**. Fora dos REQ-M1…M6.
- **Projeção `inbox` não registrada** — ela só é registrada por `dsh-agent-loop`, desligado no
  perfil claude-code (`materialize.ts:306-307`, confirmado). Isso afeta a *view* derivada, não o
  acumulador do cliente, que lê o evento cru. Durabilidade de fila é B.5, fora de escopo.
- **Ação visível de cancelar** é do cliente/DSH, não deste pacote; existência não verificada.

## 4. Achado de ambiente — fechado

| | Item | Prova |
| --- | --- | --- |
| [x] | Raiz do deck somente leitura nomeada antes de subir qualquer coisa | `assertWritableDir`; `stop.test.ts` caso 8 (novo) |
| [x] | Raiz do deck movida para `.run/deck` (decisão do dono) | `git check-ignore -v .run/deck/.env`; harnesses re-registrados |
| [x] | Chave do provider fora da árvore do projeto | `.run/deck/.env` é link para `~/.harnessdeck/.env` (modo 600) |
| [x] | `.vscode/settings.json` aponta a extensão e não vai para o git | `.gitignore:13` |
| [x] | Harness `claude` com `--key-env OPENROUTER_API_KEY` (o aviso mentia) | `up` sobe sem aviso de chave |

## 5. Fecho

| | Item | Estado |
| --- | --- | --- |
| [x] | Suíte do lançador | 9 verificações |
| [x] | Suíte da extensão | 5 verificações + smoke |
| [x] | `tsc --noEmit` no lançador e na extensão | limpo |
| [x] | VSIX reconstruído com o módulo compartilhado | 31.3 kB, 12 arquivos |
| [x] | `tsc --noEmit` na ponte | limpo |
| [x] | Commit da ponte | `f618ebb`, `4ac6944`, `27368db` |
| [x] | Push da branch | `3dc526b..a83a43a` em `feat/model-list-and-tool-approval` |
| [ ] | Reinstalar o VSIX no VS Code | depende do dono |
| [x] | Prova de REQ-P6 e REQ-L3 sem depender do host | `test/notify.test.mjs`, 7 verificações |
| [ ] | Rotacionar a chave OpenRouter exposta | depende do dono |
| [ ] | Popular a lista de workspaces do harness `dsh` | depende do dono |

## 6. Fora de escopo (registrado para não voltar)

- Daemon gerenciado pelo sistema operacional e o modo "sobreviver e reconectar": fora.
- Durabilidade da fila além do que o DSH já grava: item B.5 da spec.
- Renderização de chamada de ferramenta: item B.4.
- Qualquer mudança em `~/.dsh/`, na instalação do DSH ou em outro projeto: precisa de aval do dono.
