"""Set up both coding agents through the real command palette."""

import os
import subprocess

from cod_e2e import CodTestCase, make_repo


class AgentSetupTest(CodTestCase):
    def test_setup_installs_tools_and_both_skills_and_can_run_again(self):
        repo = make_repo(self.workdir, "project", {"hello.txt": "Hello\n"})
        self.start_cod(repo)
        home = self.cod.home
        with self.step("install from the command palette"):
            self.run_command("cod: set up coding agents")
            state = self.wait_for(lambda state: state.get("prompt") is not None, 15, "setup confirmation")
            self.assertIn("Coding agents are ready", str(state["prompt"]))
            control = home / ".local/bin/codctl"
            self.assertTrue(control.is_symlink())
            claude = home / ".claude/skills/cod-control/SKILL.md"
            codex = home / ".codex/skills/cod-control/SKILL.md"
            self.assertEqual(claude.read_text(), codex.read_text())
            self.assertIn("COD_WORKSPACE", claude.read_text())
            result = subprocess.run([str(control), "workspace", "list"], env={**os.environ, "HOME": str(home)}, capture_output=True, text=True, timeout=15)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.keys("enter")
        with self.step("run setup again without changing other agent settings"):
            settings = home / ".claude/settings.json"
            settings.write_text('{"theme":"dark"}\n')
            self.run_command("cod: set up coding agents")
            state = self.wait_for(lambda state: state.get("prompt") is not None, 15, "repeat setup confirmation")
            self.assertIn("Coding agents are ready", str(state["prompt"]))
            self.assertEqual(settings.read_text(), '{"theme":"dark"}\n')

    def test_setup_preserves_an_existing_unrelated_skill(self):
        repo = make_repo(self.workdir, "project", {"hello.txt": "Hello\n"})
        self.start_cod(repo)
        skill = self.cod.home / ".claude/skills/cod-control/SKILL.md"
        skill.parent.mkdir(parents=True)
        skill.write_text("A different skill\n")
        self.run_command("cod: set up coding agents")
        state = self.wait_for(lambda state: state.get("prompt") is not None, 15, "setup failure")
        self.assertIn("different skill", str(state["prompt"]))
        self.assertEqual(skill.read_text(), "A different skill\n")
        self.assertFalse((self.cod.home / ".local/bin/codctl").exists())
