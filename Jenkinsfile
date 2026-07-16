// Single pipeline triggered every minute, running on a labeled ANS agent
// (bookwormjdk17 — has git + Node 18). No Docker: the ping-segur agent has no
// docker binary, so we run the Node scripts directly on the agent.
//
//  - Every minute: curl all URLs in urls.json, write one docs/data/http/<id>.json
//    per URL, rebuild the manifest (docs/data/index.json), then commit + push to
//    main (statuses land in git in near real time). These commits touch only
//    docs/data/**.
//  - GitHub Pages is deployed by .github/workflows/pages.yml on a 2h schedule;
//    it ignores docs/data/** pushes, so the per-minute commits don't redeploy it.
//
// Data durability: skipDefaultCheckout(true) means the per-minute build never
// re-checks-out and thus never wipes the docs/data working tree in the persistent
// branch workspace. We clone once, then commit/push each run.

pipeline {
  // No global agent: the agent is acquired inside a bounded stage below so we can
  // put a timeout on the *wait* for it (see the 'Run on agent' stage).
  agent none

  triggers { cron('* * * * *') }

  options {
    disableConcurrentBuilds()          // skip a tick rather than overlap runs
    skipDefaultCheckout(true)          // never let checkout wipe uncommitted appended data
    buildDiscarder(logRotator(numToKeepStr: '5'))
    timeout(time: 5, unit: 'MINUTES')  // overall cap once we're running on the agent
  }

  environment {
    BRANCH      = 'main'
    // Reuse the multibranch GitHub App credential (the one branch indexing uses).
    // Adjust the id here if it differs from what checkout scm is configured with.
    GIT_CRED_ID = 'GithubTokenAnsForge'
  }

  stages {
    // Kill the build if no 'bookormjdk17persistent' executor becomes available
    // within 3 minutes. A stage-level timeout combined with a stage-level agent
    // counts the time spent waiting to allocate that agent, so an offline/stuck
    // agent aborts the run instead of letting per-minute builds queue up. All the
    // real work runs as nested stages, which share this stage's agent + workspace
    // (required so the in-progress daily JSON survives between them).
    stage('Run on agent') {
      agent { label 'bookormjdk17persistent' }
      options { timeout(time: 3, unit: 'MINUTES') }

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
            // Curl every URL in urls.json and write one docs/data/http/<id>.json
            // per URL (latest status snapshot, overwritten each run). At ~900 URLs
            // this rewrites up to 900 files each minute — bounded in size, but the
            // commit below then touches many files. curl honours the pod proxy +
            // system CA store, which a bare Node fetch would not.
            sh 'node scripts/collect-http.js'
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
  }
}
