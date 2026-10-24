# Instruções para agentes

- Escreva documentação, diagnósticos e descrições de PR em português do Brasil.
- Leia `docs/SPEC.md` e o README para compreender contratos, comandos e limites do serviço.
- Investigue o incidente recebido com base no código, nos testes e nas evidências de execução. Não amplie o escopo sem uma tarefa específica.
- Reproduza a falha, acrescente um teste de regressão e aplique uma correção mínima.
- Não desative o Sentry, não esconda exceções, não enfraqueça testes e não altere fixtures para evitar o caso.
- Relate apenas comandos e verificações realmente executados.
- Não publique credenciais ou dados reais. Não faça merge nem deploy como parte de uma tarefa de diagnóstico ou abertura de PR.
- Preserve branches e histórico existentes.
- Ao concluir a tarefa, encerre todos os processos que você iniciou.

## Patchwork, skills e Sentry

- Em uma execução do Patchwork, leia e use `.agents/skills/service-regression/SKILL.md` e `.agents/skills/patchwork-investigation/SKILL.md`, disponibilizada pelo workflow.
- Consulte o MCP `sentry` para o incidente, evento e release recebidos. O servidor é limitado ao projeto Sentry de origem validado pelo workflow e a ferramentas de leitura.
- O escopo de arquivos, o padrão de testes e a branch autorizada estão em `.github/patchwork.json`.

- Se a investigação encontrar evidências de responsabilidade de outro repositório, consulte `.agents/skills/patchwork-handoff/SKILL.md`, quando disponibilizada pelo workflow. Não é uma triagem prévia obrigatória. Somente a saída de encaminhamento dispensa patch e teste novo na origem.
