// Single pipeline triggered every minute, running on a labeled ANS agent
// (bookwormjdk17 — has git + Node 18). No Docker: the ping-segur agent has no
// docker binary, so we run the Node scripts directly on the agent.
//
//  - Every minute: ping all targets, append to docs/data/<day>.json, rebuild the
//    manifest, then commit + push to main (measurements land in git in near
//    real time). These commits touch only docs/data/**.
//  - GitHub Pages is deployed by .github/workflows/pages.yml on a 2h schedule;
//    it ignores docs/data/** pushes, so the per-minute commits don't redeploy it.
//
// Data durability: skipDefaultCheckout(true) means the per-minute build never
// re-checks-out and thus never wipes uncommitted appended data in the persistent
// branch workspace. We clone once, then commit/push each run.

pipeline {
  agent { label 'bookormjdk17persistent' }

  triggers { cron('* * * * *') }

  options {
    disableConcurrentBuilds()          // skip a tick rather than overlap runs
    skipDefaultCheckout(true)          // never let checkout wipe uncommitted appended data
    buildDiscarder(logRotator(numToKeepStr: '10'))
    timeout(time: 5, unit: 'MINUTES')
  }

  environment {
    BRANCH      = 'main'
    // Reuse the multibranch GitHub App credential (the one branch indexing uses).
    // Adjust the id here if it differs from what checkout scm is configured with.
    GIT_CRED_ID = 'ans-forge'
  }

  stages {
    stage('Ensure repo') {
      steps {
        script {
          // First build on this agent: populate the persistent workspace using the
          // multibranch SCM config (App credentials). Subsequent builds reuse it so
          // the in-progress daily JSON survives between runs.
          if (!fileExists('.git')) {
            checkout scm
          }
        }
        sh '''
          set -e
          git checkout -B "$BRANCH"
          git config user.email "michael.faurel@esante.gouv.fr"
          git config user.name  "segur-ping bot"
          node --version
        '''
      }
    }

    stage('Collect') {
      steps {
        sh 'node scripts/collect.js'
      }
    }

    // Commit + push EVERY minute so measurements land in git in near real time.
    // These commits only touch docs/data/**, which the Pages workflow ignores, so
    // they do NOT trigger a Pages deploy (that runs on a 2h schedule instead).
    stage('Commit & push') {
      steps {
        withCredentials([gitUsernamePassword(credentialsId: env.GIT_CRED_ID)]) {
          sh '''
            set -e
            node scripts/build-site.js
            git add docs/data
            if git diff --cached --quiet; then
              echo "No data changes this run"
              exit 0
            fi
            git commit -m "data: $(date -Iseconds)"
            git pull --rebase origin "$BRANCH"
            git push origin HEAD:"$BRANCH"
          '''
        }
      }
    }
  }
}
