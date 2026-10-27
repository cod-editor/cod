"""Discover agent plugins without changing agent configuration."""

import json
import os
from pathlib import Path

from cod_e2e import CodTestCase, make_repo
from fake_acp_agent import fake_agent_settings
from test_37_codctl import Codctl


class AgentSetupTest(CodTestCase):
    def test_notice_is_nonmodal_shown_once_and_can_be_reopened(self):
        repo = make_repo(self.workdir, "project", {"hello.txt": "Hello\n"})
        self.start_cod(repo, persistent=True)
        state = self.wait_for(lambda state: state.get("coding_agent_setup_notice"), 15, "first-use plugin notice")
        self.assertIsNone(state["prompt"])
        self.assertIsNone(state["modal"])
        for directory in (".claude", ".agents", ".codex"):
            self.assertFalse((self.cod.home / directory / "skills/cod-control/SKILL.md").exists())
        self.assertFalse((self.cod.home / ".local/bin/codctl").exists())
        client = Codctl(Path(os.environ["COD_E2E_RUN_DIR"]) / "codctl", self.cod.home)
        other = make_repo(self.workdir, "other", {"other.txt": "Other\n"})
        result = client.run("workspace", "new", "--folder", str(other), "--focus")
        self.assertEqual(result.returncode, 0, result.stderr)
        state = self.wait_for(lambda state: state["active_workspace"] == 1, 15, "other workspace focused")
        self.assertTrue(state["coding_agent_setup_notice"])
        self.restart_cod()
        self.assertFalse(self.state()["coding_agent_setup_notice"])
        self.run_command("cod: set up coding agents")
        self.wait_for(lambda state: state.get("coding_agent_setup_notice"), 15, "reopened plugin notice")
        self.assertIsNone(self.state()["prompt"])

    def test_explicit_codctl_install_can_run_again_and_agents_receive_workspace(self):
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
        self.start_cod(repo, extra_settings={"agent_servers": {"claude": agent}})
        home = self.cod.home
        with self.step("install from the command palette"):
            self.run_command("cod: install codctl")
            state = self.wait_for(lambda state: state.get("prompt") is not None, 15, "setup confirmation")
            self.assertIn("codctl is ready", str(state["prompt"]))
            control = home / ".local/bin/codctl"
            self.assertTrue(control.is_symlink())
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
            settings.parent.mkdir(exist_ok=True)
            settings.write_text('{"theme":"dark"}\n')
            self.run_command("cod: install codctl")
            state = self.wait_for(lambda state: state.get("prompt") is not None, 15, "repeat setup confirmation")
            self.assertIn("codctl is ready", str(state["prompt"]))
            self.assertEqual(settings.read_text(), '{"theme":"dark"}\n')

    def test_codctl_install_preserves_an_existing_regular_file(self):
        repo = make_repo(self.workdir, "project", {"hello.txt": "Hello\n"})
        self.start_cod(repo)
        control = self.cod.home / ".local/bin/codctl"
        control.parent.mkdir(parents=True)
        control.write_text("An unrelated command\n")
        self.run_command("cod: install codctl")
        state = self.wait_for(lambda state: state.get("prompt") is not None, 15, "installation failure")
        self.assertIn("not a symlink", str(state["prompt"]))
        self.assertEqual(control.read_text(), "An unrelated command\n")
