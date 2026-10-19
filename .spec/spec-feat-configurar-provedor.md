# Spec — configurar o provedor pelo painel

Origem: o dono foi apontar um harness para o Gemini pelo *settings* do HD e não achou. O que existia
em `Settings`: `harnessDeck.home`, `dshCommand`, `autoStart`, `stopOnExit`, `openSystemBrowser` —
nada de rota, modelo ou chave. Fechar isso é dar ao dono, dentro do painel, o mesmo que
`harness-deck add --force --provider ...` faz no terminal.

Pedido literal dele, na sequência: *"no add model tem vários pré configurados, so colocar api key"*.
Ou seja: o fluxo **oferece** o catálogo instalado; não obriga a digitar slug.

---

## 1. O que já foi lido (não é suposição)

Do `@earendil-works/pi-ai` que o DSH `0.2.0-rc.2` instala, em `dist/providers/all.js`:

- `getBuiltinProviders()` → 41 ids de rota (`openrouter`, `google`, `anthropic`, `groq`, `xai`,
  `mistral`, `zai`, `together`, `ollama`, …).
- `getBuiltinModels(rota)` → os modelos daquela rota, com `id`, `name`, `api` e `baseUrl`. Para
  `google`, 22.

A tabela `PROVIDER_ROUTES` do deck é atalho, não permissão: rota que está no catálogo e não está na
tabela (`xai`, `groq`, …) continua válida, e o catálogo responde a URL e o protocolo dela.

O catálogo é **lido do DSH instalado**, nunca copiado para dentro do deck: catálogo escrito duas
vezes é como o painel passa a oferecer um modelo que o motor não conhece.

---

## 2. Requisitos

| | Requisito | Prova exigida |
| --- | --- | --- |
| **REQ-C1** | Existe o comando `Harness Deck: Configurar provedor`, oferecido na árvore do harness e na paleta, com o harness como argumento quando veio da árvore. | Asserção no teste de que a extensão registra `harnessDeck.configureProvider` e de que o `package.json` o declara em `contributes.commands` **e** em `activationEvents`. Sem isso o comando pode existir e nunca ativar. |
| **REQ-C2** | A escolha de rota oferece as rotas do catálogo instalado, mais `outra rota (informar URL e protocolo)`. Nunca uma lista inventada pelo deck. | Asserção sobre os labels oferecidos com catálogo presente (as rotas do catálogo) e com catálogo ausente (as chaves de `PROVIDER_ROUTES`). |
| **REQ-C3** | A escolha de modelo é um multi-select com os modelos **do catálogo da rota escolhida**, mostrando `name` e `id`. Digitar slug é exceção, não regra. | Asserção de que, para `google`, os ids oferecidos são exatamente os de `getBuiltinModels('google')`. |
| **REQ-C4** | Sem catálogo legível, o fluxo **avisa** que não conseguiu ler, pede o id por input box e **nunca** oferece lista vazia. | Asserção de aviso + prompt de id + ausência de pick de modelos. |
| **REQ-C5** | Rota fora da tabela do deck **e** fora do catálogo exige URL e protocolo, e falha nomeando o campo que falta **antes** de chamar o CLI. | Asserção dupla: nenhuma chamada ao CLI quando falta `baseUrl`/`api`, e a mensagem nomeia o campo. |
| **REQ-C6** | A variável da chave sugerida é a **da rota** (`providerKeyEnv`), e o dono pode trocá-la. | Asserção do valor sugerido para `google` = `GEMINI_API_KEY` e do que é gravado quando ele troca. |
| **REQ-C7** | A gravação passa pelo CLI (`add --force`, com `HARNESS_DECK_HOME`), preservando o resto da entrada do registro. | `provider.test.mjs` + ciclo real que lê o `harnesses.json` gravado. |
| **REQ-C8** | Ao terminar, o dono vê qual rota e qual variável passaram a valer, e é avisado de que **o harness precisa ser reiniciado**; a ação oferecida reinicia. | Asserção do texto exibido e de que a ação "reiniciar" chama o comando de restart existente. |
| **REQ-C9** | O `npm test` da extensão é **determinístico**: rodar a suíte completa três vezes seguidas dá o mesmo resultado, com a mesma contagem de verificações. | Três execuções completas registradas no relatório, com a contagem de cada arquivo de teste. |
| **REQ-C10** | Nenhum segredo é escrito em arquivo do repositório pela configuração do painel: a chave continua vindo do ambiente ou do `.env` do deck home. | Inspeção do que o fluxo grava: só nome de variável, nunca valor. Asserção no teste de que nenhum valor de chave aparece nos argumentos do CLI. |

---

## 3. Fora de escopo

- Interface para criar harness novo pelo painel (hoje o fluxo configura um harness já registrado).
- Editar `workspaces` do harness pela tela do provedor.
- Gravar a chave dentro do registro ou do perfil. A regra do repositório não muda: chave só no
  ambiente ou no `.env` do deck home.
- Ler a lista de modelos por consulta ao provedor. O que o painel oferece é o catálogo instalado,
  que é o que o motor de fato aceita.
