# Protocolo de Resolução de Falhas em Execução de Tasks (RCA & Prevenção de Recorrência)

## Objetivo

Definir o protocolo operacional obrigatório para qualquer agent que encontre falha, erro, regressão ou bloqueio técnico durante a execução de uma task no ecossistema **Nexora AI (`PPC → RC → HD → DSH`)**.

Nenhuma task que sofra problema de execução pode ser marcada como concluída (`done`) com contornos improvisados (*workarounds* silenciosos). O agent deve cumprir integralmente o ciclo de **7 etapas** abaixo antes de encerrar o serviço.

---

## Regra de Ouro (Gate de Conclusão)

```text
1. Avaliar o problema (Diagnóstico e Causa Raiz)
   ↓
2. Propor mudança (Plano de Correção e Impacto)
   ↓
3. Executar (Implementação Mínima e Sincronizada)
   ↓
4. Testar (Validação Direcionada + Teste de Regressão)
   ↓
5. Gerar evidências (Artefatos, Logs e Comandos Verificáveis)
   ↓
6. Guardar a solução (Memória/Runbook/Regra para Não Repetir)
   ↓
7. Concluir o serviço (Handoff e Atualização de Status)
```

> **Bloqueio obrigatório:** Se qualquer uma das etapas 1 a 6 não estiver completa e comprovada, a etapa 7 (`done`) é **proibida**. Caso o problema exija permissão externa ou decisão de arquitetura fora da alçada do agent, a task deve transicionar para `blocked` com os passos 1 e 2 documentados.

## Responsabilidade do Owner

Quando o agent é owner do projeto, toda falha dentro do escopo do próprio projeto continua sob responsabilidade dele. Falha de código, teste, build, dependência, migração, configuração, script, documentação, integração local, workspace ou runtime autorizado não é bloqueio externo.

O owner deve diagnosticar, mudar a abordagem, corrigir e validar novamente. Não pode encerrar, delegar ou marcar como `blocked` apenas porque a primeira implementação falhou ou porque a solução exige investigação técnica.

O anti-loop da Etapa 1 interrompe somente a repetição cega da mesma abordagem. Ele não encerra a tarefa: depois de duas tentativas sem progresso, o agent deve reavaliar o contexto, formular uma hipótese diferente e continuar por uma estratégia alternativa segura.

Só existe bloqueio quando a próxima ação depende comprovadamente de autoridade, credencial, aprovação, recurso ou decisão fora do controle do owner. “Não funcionou”, “o teste falhou” e “a primeira tentativa falhou” não são bloqueios válidos.

---

## Ciclo Obrigatório de 7 Etapas

### 1. Avaliar o Problema (Diagnóstico e Causa Raiz)

Antes de alterar qualquer arquivo ou tentar comandos aleatórios:

- **Capturar o erro exato:** preservar stack trace, código de saída (`exit code`), payload HTTP, log do `heartbeat_run_events` ou saída do terminal.
- **Isolar o escopo e a camada afetada:** identificar onde a falha ocorre (`packages/db`, `packages/shared`, `server`, `ui`, `cli`, `RC`, `HD` ou `DSH`) e garantir o isolamento por `companyId`.
- **Reproduzir de forma determinística:** confirmar como provocar o erro de maneira controlada.
- **Identificar a Causa Raiz (RCA):** distinguir o *sintoma* (ex.: teste quebrando ou erro 500) da *causa real* (ex.: contrato dessincronizado, migração pendente, estado sujo, falta de validação).
- **Anti-loop:** se 2 tentativas de diagnóstico ou reprodução falharem sem progresso novo (`attempts_without_progress >= 2`), interromper tentativas cegas e reavaliar o contexto completo.

### 2. Propor Mudança (Plano de Correção)

Antes de aplicar a correção:

- **Formular a proposta técnica:** descrever claramente o que será alterado, em quais arquivos/camadas e por quê.
- **Avaliar impacto colateral:** verificar se a mudança afeta contratos compartilhados (`db` ↔ `shared` ↔ `server` ↔ `ui`), invariantes do control plane ou políticas do Release Control (`RC`).
- **Definir critério de aceite da correção:** especificar qual teste ou comando provará que o problema foi resolvido sem introduzir regressões.
- **Governança / Gate:**
  - Se a mudança for interna ao escopo já aprovado da task, registrar a proposta no log/comentário de progresso da task e prosseguir.
  - Se a mudança alterar contrato canônico, schema de banco não previsto, segurança ou escopo governado pelo RC, submeter a proposta para aprovação (`REQUEST_CHANGES` / gate humano ou do RC) antes de executar.

### 3. Executar a Mudança

Com a proposta definida (e aprovada, quando exigido):

- **Escopo cirúrgico:** aplicar apenas a mudança necessária para corrigir a causa raiz e sincronizar as camadas afetadas.
- **Preservar invariantes:** manter isolamento por `companyId`, checkout atômico, activity log para mutações e regras de token/design (`DESIGN.md` na UI).
- **Proibido mascarar falhas:** não usar `.skip` em testes, não silenciar `catch` sem tratamento, não usar `@ts-ignore` / `any` para esconder erros de tipagem e não desabilitar validações do RC.

### 4. Testar (Correção + Prevenção de Regressão)

A correção não existe até ser provada por testes automatizados e verificações reais:

- **Criar ou atualizar teste de regressão:** adicionar um teste que falharia antes da correção e que passa agora, garantindo que o bug não volte silenciosamente.
- **Verificação direcionada primeiro:** rodar o teste unitário/integração específico do módulo afetado.
- **Verificação das camadas impactadas:**
  - Typecheck: `pnpm -r typecheck`
  - Testes: `pnpm test` / `pnpm test:run`
  - Build (quando aplicável): `pnpm build`
  - UI (se tocou em `ui/`): `pnpm check:token-gates`

### 5. Gerar Evidências

Toda execução e teste deve produzir evidência auditável vinculada a `companyId`, `taskId` e `runId`:

- **Evidência técnica:** comando exato executado, saída resumida com status de aprovação (`PASS` / `exit code 0`), hash do commit/diff e caminho dos testes criados.
- **Artefatos inspecionáveis:** quando houver arquivo gerado (relatório, log, screenshot, bundle), anexar via fluxo oficial de artefatos/work products do Paperclip/Nexora (não depender apenas de caminho efêmero local).
- **Rastreabilidade no RC/PPC:** anexar as evidências na thread/comentário da task e no payload de validação do Release Control.

### 6. Guardar a Solução para Não Repetir (Prevenção de Recorrência)

O aprendizado deve ser persistido antes do fechamento para que nenhum agent repita o mesmo erro:

- **Teste automatizado permanente:** o teste de regressão criado na Etapa 4 permanece na suíte do repositório.
- **Registro de conhecimento / Memória:** registrar a lição aprendida no local adequado à natureza da falha:
  1. **Memória do Projeto / Knowledge Base (Workplane):** quando for armadilha específica do projeto, configuração de ambiente ou regra de domínio.
  2. **Documentação operacional / Runbook (`doc/`):** quando envolver operação, migração, setup ou integração (`PPC → RC → HD → DSH`).
  3. **Skill ou Regra (`skills/` ou instruções de projeto):** quando for um padrão de execução reutilizável por outros agents.
- **Formato mínimo do registro de aprendizado:**
  - *Problema / Sintoma:* como o erro se manifestou.
  - *Causa Raiz:* por que aconteceu.
  - *Solução Aplicada:* como foi corrigido.
  - *Regra de Prevenção:* como evitar ou detectar automaticamente no futuro.

### 7. Concluir o Serviço

Somente após as etapas 1 a 6 estarem 100% cumpridas:

- Publicar na task o **Relatório de Resolução e Conclusão** (template abaixo).
- Submeter as evidências ao gate final do Release Control (`RC`), quando a task for `release_controlled`.
- Atualizar o status da task para `done`.

---

## Template de Registro Obrigatório (Comentário Final / Evidência)

Sempre que uma task passar por problema de execução, o agent deve incluir este bloco preenchido antes de concluir:

```markdown
## Relatório de Resolução de Incidente na Task

### 1. Avaliação do Problema (RCA)
- **Sintoma / Erro observado:** <mensagem de erro, código HTTP ou falha>
- **Camada / Arquivos afetados:** <ex.: server/src/..., packages/shared/...>
- **Causa raiz:** <explicação objetiva do motivo real da falha>

### 2. Mudança Proposta
- **Estratégia de correção:** <o que foi decidido fazer e por quê>
- **Impacto em contratos/camadas:** <nenhum | db / shared / server / ui sincronizados>

### 3. Execução Realizada
- **Arquivos alterados:** <lista de arquivos com links>
- **Resumo das alterações:** <mudanças aplicadas>

### 4. Testes Executados
- **Teste de regressão adicionado/atualizado:** <caminho do arquivo de teste>
- **Comandos de verificação:**
  - `<comando 1>` → PASS
  - `<comando 2>` → PASS

### 5. Evidências Geradas
- **Run / Task / Commit:** `runId: <id>` | `taskId: <id>` | `commit: <sha>`
- **Artefatos / Logs verificados:** <links ou referências das evidências>

### 6. Prevenção de Recorrência (Conhecimento Guardado)
- **Onde foi registrado:** <caminho do teste / memória do projeto / doc / skill>
- **Regra aprendida:** <1 parágrafo resumindo como o sistema/agent evita repetir o erro>

### 7. Conclusão
- [x] Problema avaliado na raiz
- [x] Mudança proposta e validada
- [x] Correção executada sem workarounds ocultos
- [x] Testes passando
- [x] Evidências anexadas
- [x] Solução guardada para não repetir
- **Status final:** `DONE`
```

---

## Checklist Rápido para o Agent (Prompt Enforcer)

Use este bloco como instrução direta em prompts de agents ou envelopes de execução:

```text
PROTOCOLO DE FALHA DE EXECUÇÃO (OBRIGATÓRIO):
Se ocorrer qualquer erro ou falha durante a execução desta task, você está PROIBIDO de concluir a task ou ignorar o erro. Execute obrigatoriamente nesta ordem:
1. AVALIE: identifique o erro exato, reproduza e encontre a causa raiz (RCA).
2. PROPONHA: documente a mudança corretiva e verifique o impacto entre camadas.
3. EXECUTE: aplique a correção definitiva respeitando os contratos e invariantes.
4. TESTE: crie/atualize teste de regressão e rode typecheck/testes até ficarem verdes.
5. EVIDENCIE: registre comandos, saídas, runId/taskId e artefatos verificáveis.
6. GUARDE A SOLUÇÃO: persista o aprendizado (teste de regressão + memória/doc/runbook) para que o erro nunca se repita.
7. CONCLUA: somente com os itens 1 a 6 comprovados no relatório final, marque o serviço como concluído.
```
