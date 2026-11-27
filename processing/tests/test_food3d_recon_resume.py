import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/food3d/run_track2b.sh'


class ReconstructionResumeTest(unittest.TestCase):
    def test_resume_reaches_blender_without_running_reconstruction(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            recon = root / 'recon'
            recon.mkdir()
            (recon / 'dense_clean.glb').write_bytes(b'mesh')
            (recon / 'track2b_recon_meta.json').write_text('{}')
            blender = root / 'blender'
            blender.write_text('#!/bin/sh\nexit 37\n')
            blender.chmod(0o755)
            env = dict(os.environ, T2B_RECON_DIR=str(recon), BLENDER=str(blender))
            env.pop('T2B_REUSE_DIR', None)
            env.pop('T2B_POSE_REFINE', None)
            result = subprocess.run(['bash', str(SCRIPT), 'dish', str(root / 'dataset'), str(root / 'out'), '24', '9000'], env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 37, result.stderr)
            self.assertIn('Using existing reconstruction', result.stdout)
            self.assertEqual((root / 'out/dish/dense_clean.glb').read_bytes(), b'mesh')

    def test_missing_reconstruction_fails_before_output_cleanup(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            marker = root / 'out/dish/lod_existing'
            marker.parent.mkdir(parents=True)
            marker.write_text('keep')
            env = dict(os.environ, T2B_RECON_DIR=str(root / 'missing'))
            result = subprocess.run(['bash', str(SCRIPT), 'dish', str(root / 'dataset'), str(root / 'out')], env=env, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertTrue(marker.exists())

if __name__ == '__main__':
    unittest.main()
