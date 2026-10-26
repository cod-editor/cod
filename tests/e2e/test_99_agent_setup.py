"""Set up both coding agents through the real command palette."""

import json
import os
from unittest.mock import patch

from cod_e2e import CodTestCase, make_repo
from fake_acp_agent import fake_agent_settings
from test_37_codctl import Codctl


class AgentSetupTest(CodTestCase):
    def test_setup_installs_tools_and_both_skills_and_can_run_again(self):
        repo = make_repo(self.workdir, "project", {"hello.txt": "Hello\n"})
        script = self.workdir / "agent.json"
        script.write_text(json.dumps({"session_ids": ["setup-session"], "turns": []}))
        environment_file = self.workdir / "agent-environment.json"
        agent = fake_agent_settings(script)
        agent_script = agent["args"][0]
        agent["args"] = ["-c", (
            "import json,os,runpy; from pathlib import Path; "
            f"Path({str(environment_file)!r}).write_text(json.dumps(os.environ.get('COD_WORKSPACE'))); "
            f"runpy.run_path({agent_script!r}, run_name='__main__')"
        )]
        codex_home = self.workdir / "codex-home"
        with patch.dict(os.environ, {"CODEX_HOME": str(codex_home)}):
            self.start_cod(repo, extra_settings={"agent_servers": {"claude-acp": agent}})
        home = self.cod.home
        with self.step("install from the command palette"):
            self.run_command("cod: set up coding agents")
            state = self.wait_for(lambda state: state.get("prompt") is not None, 15, "setup confirmation")
            self.assertIn("Coding agents are ready", str(state["prompt"]))
            control = home / ".local/bin/codctl"
            self.assertTrue(control.is_symlink())
            claude = home / ".claude/skills/cod-control/SKILL.md"
            codex = codex_home / "skills/cod-control/SKILL.md"
            self.assertEqual(claude.read_text(), codex.read_text())
            self.assertIn("COD_WORKSPACE", claude.read_text())
            client = Codctl(control, home)
            result = client.run("workspace", "list")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.keys("enter")
            self.wait_for(lambda state: state.get("prompt") is None, 15, "confirmation closed")
            self.wait_for(lambda state: state.get("agent_panel_ready") is True, 15, "agent panel")
            result = client.run("session", "new", "--agent", "claude")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.strip(), "setup-session")
            listed = client.run("workspace", "list", "--json")
            self.assertEqual(listed.returncode, 0, listed.stderr)
            workspace_id = json.loads(listed.stdout)[0]["id"]
            self.assertEqual(json.loads(environment_file.read_text()), str(workspace_id))
        with self.step("run setup again without changing other agent settings"):
            settings = home / ".claude/settings.json"
            settings.write_text('{"theme":"dark"}\n')
            self.run_command("cod: set up coding agents")
            state = self.wait_for(lambda state: state.get("prompt") is not None, 15, "repeat setup confirmation")
            self.assertIn("Coding agents are ready", str(state["prompt"]))
            self.assertEqual(settings.read_text(), '{"theme":"dark"}\n')

    def test_setup_preserves_an_existing_unrelated_skill(self):
        repo = make_repo(self.workdir, "project", {"hello.txt": "Hello\n"})
        with patch.dict(os.environ, {"CODEX_HOME": str(self.workdir / "codex-home")}):
            self.start_cod(repo)
        skill = self.cod.home / ".claude/skills/cod-control/SKILL.md"
        skill.parent.mkdir(parents=True)
        skill.write_text("A different skill\n")
        self.run_command("cod: set up coding agents")
        state = self.wait_for(lambda state: state.get("prompt") is not None, 15, "setup failure")
        self.assertIn("different skill", str(state["prompt"]))
        self.assertEqual(skill.read_text(), "A different skill\n")
        self.assertFalse((self.cod.home / ".local/bin/codctl").exists())
