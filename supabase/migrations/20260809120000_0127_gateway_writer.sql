-- 0127 — o papel `gateway_writer`: a quarta superfície ganha dono, e ele não toca tabela.
--
-- Contexto (spec 004, decisão de escrita direta de 2026-08-08, constituição v2.3.0
-- Princípio VII): o fork do `gateway_go` apontado para o banco do CRM passa a
-- gravar mensagem, conversa e contato aqui. A constituição permite isso **só**
-- pela "quarta superfície" — função `security definer` versionada — e **só** sob
-- seis travas. Esta migration entrega a trava nº 1 e a nº 2:
--
--   1. zero grant de tabela, nem `select`;
--   2. papel Postgres dedicado, NUNCA `service_role` nem o segredo do JWT.
--
-- A trava nº 5 (invariante em CI que reprova se este papel ganhar privilégio de
-- tabela) vive em `tests/invariants/gateway-writer-sem-tabela.test.ts`. Sem ela
-- esta migration é só boa intenção: nada impede um `grant` futuro de desfazer
-- tudo em silêncio. **Se você removeu o invariante, removeu a permissão.**
--
-- ═══ Por que `nologin` ═══
--
-- O gateway não abre conexão Postgres própria: ele fala PostgREST e apresenta um
-- JWT com `{"role":"gateway_writer"}`, e o PostgREST troca de papel. Papel com
-- login seria superfície de ataque a mais sem nenhum uso.
--
-- ═══ A armadilha do `authenticator` (medida, e ela reprova o gate obrigatório) ═══
--
-- Para o PostgREST poder trocar de papel, `authenticator` precisa ser membro de
-- `gateway_writer`. Só que **`authenticator` não existe no Postgres efêmero do
-- `pnpm test:db`**: `scripts/test-db.sh` cria `anon`, `authenticated` e
-- `service_role`, e mais ninguém; e o `baseline.sql` não menciona `authenticator`
-- (os papéis de cluster do Supabase não entram no dump de schema).
--
-- Um `grant ... to authenticator` solto passa na nossa instância e **reprova o
-- job `invariants`**, que é obrigatório na branch protection. É o pior padrão de
-- falha: parece funcionar exatamente onde você testou. Daí o `if exists`.

-- ---- o papel ----
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'gateway_writer') then
    create role gateway_writer nologin;
  end if;

  -- Sem isto o papel não enxerga nem as funções. Note que USAGE em schema NÃO dá
  -- acesso a tabela nenhuma — o acesso a tabela é grant próprio, e ele não vem.
  execute 'grant usage on schema public to gateway_writer';

  -- Só onde `authenticator` existe (produção/Supabase local). Ver o cabeçalho.
  if exists (select 1 from pg_roles where rolname = 'authenticator') then
    execute 'grant gateway_writer to authenticator';
  end if;
end $$;

-- ---- garantia explícita: NENHUM privilégio de tabela ----
--
-- Defensivo de propósito. O baseline tem `ALTER DEFAULT PRIVILEGES ... GRANT ALL
-- ON TABLES` para outros papéis, e uma re-aplicação futura em ordem diferente
-- poderia alcançar este. Revogar o que nunca foi concedido é no-op barato; não
-- revogar e descobrir depois custa a trava nº 1.
revoke all on all tables in schema public from gateway_writer;
revoke all on all sequences in schema public from gateway_writer;
revoke all privileges on schema public from gateway_writer;
grant usage on schema public to gateway_writer;

-- ---- as três funções que JÁ existem e o gateway reaproveita ----
--
-- Criadas para o caminho do WAHA (baseline.sql:4187-4234). Não mudam de
-- assinatura nem de corpo: só ganham mais um executor.
grant execute on function public.fn_upsert_wa_contact(uuid, text, text, text, text, text) to gateway_writer;
grant execute on function public.fn_upsert_wa_conversation(uuid, uuid, uuid) to gateway_writer;
grant execute on function public.fn_mark_conversation_message(uuid, text, text, timestamptz) to gateway_writer;

comment on role gateway_writer is
  'Quarta superficie (constituicao v2.3.0, Principio VII): o gateway_go escreve no CRM SO por funcao security definer versionada. Este papel NAO pode receber grant de tabela — nem select. Vigiado por tests/invariants/gateway-writer-sem-tabela.test.ts.';
