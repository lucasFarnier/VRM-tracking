import { VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import { useAnimations, useFBX, useGLTF } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { Face, Hand, Pose } from "kalidokit";
import { useControls, button } from "leva";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bone, Skeleton, SkinnedMesh, BufferGeometry, Float32BufferAttribute, Vector3, Matrix4, Quaternion, Euler, Object3D } from "three";
import { CCDIKSolver } from "three/examples/jsm/animation/CCDIKSolver.js";
import { lerp } from "three/src/math/MathUtils.js";
import { useVideoRecognition } from "../hooks/useVideoRecognition";
import { remapMixamoAnimationToVrm } from "../utils/remapMixamoAnimationToVrm";

const tmpVec3 = new Vector3();
const tmpQuat = new Quaternion();
const tmpEuler = new Euler();
const tmpMatrix = new Matrix4();

function calculateCustomWristRotation(landmarks, isRightHand, lowerArmBone) {
    if (!landmarks || landmarks.length < 21 || !lowerArmBone) return null;

    const wrist = new Vector3(landmarks[0].x, -landmarks[0].y, landmarks[0].z);
    const indexKnuckle = new Vector3(landmarks[5].x, -landmarks[5].y, landmarks[5].z);
    const pinkyKnuckle = new Vector3(landmarks[17].x, -landmarks[17].y, landmarks[17].z);

    const toIndex = new Vector3().subVectors(indexKnuckle, wrist).normalize();
    const toPinky = new Vector3().subVectors(pinkyKnuckle, wrist).normalize();

    const palmNormal = new Vector3();
    if (isRightHand) {
        palmNormal.crossVectors(toPinky, toIndex).normalize();
    } else {
        palmNormal.crossVectors(toIndex, toPinky).normalize();
    }

    const forward = toIndex.clone();
    const up = palmNormal.clone();
    const right = new Vector3().crossVectors(forward, up).normalize();

    const rotationMatrix = new Matrix4().makeBasis(right, up, forward);
    const desiredWorldQuat = new Quaternion().setFromRotationMatrix(rotationMatrix);

    // Convert World Rotation -> Local Bone Rotation space
    const lowerArmWorldQuat = new Quaternion();
    lowerArmBone.getWorldQuaternion(lowerArmWorldQuat);

    const localQuat = new Quaternion()
        .copy(lowerArmWorldQuat)
        .invert()
        .multiply(desiredWorldQuat);

    return localQuat;
}

function solveHandQuaternion(landmarks, isRightHand) {
    if (!landmarks || landmarks.length < 21) return null;

    const wrist = landmarks[0];
    const indexMCP = landmarks[5];
    const middleMCP = landmarks[9];
    const pinkyMCP = landmarks[17];

    const toMiddle = new Vector3(
        middleMCP.x - wrist.x,
        -(middleMCP.y - wrist.y),
        middleMCP.z - wrist.z
    ).normalize();

    const toPinky = new Vector3(
        pinkyMCP.x - wrist.x,
        -(pinkyMCP.y - wrist.y),
        pinkyMCP.z - wrist.z
    ).normalize();

    const palmNormal = isRightHand
        ? new Vector3().crossVectors(toPinky, toMiddle).normalize()
        : new Vector3().crossVectors(toMiddle, toPinky).normalize();

    const handX = toMiddle.clone();
    const handY = palmNormal.clone().negate();
    const handZ = new Vector3().crossVectors(handX, handY).normalize();
    const handY2 = new Vector3().crossVectors(handZ, handX).normalize();

    tmpMatrix.makeBasis(handX, handY2, handZ);
    return new Quaternion().setFromRotationMatrix(tmpMatrix);
}

export const VRMAvatar = ({ avatar, ...props }) => {
    const { scene, userData } = useGLTF(
        `models/${avatar}`,
        undefined,
        undefined,
        (loader) => {
            loader.register((parser) => {
                return new VRMLoaderPlugin(parser);
            });
        }
    );

    const assetA = useFBX("models/animations/Swing Dancing.fbx");
    const assetB = useFBX("models/animations/Thriller Part 2.fbx");
    const assetC = useFBX("models/animations/Breathing Idle.fbx");

    const currentVrm = userData.vrm;

    const animationClipA = useMemo(() => {
        const clip = remapMixamoAnimationToVrm(currentVrm, assetA);
        clip.name = "Swing Dancing";
        return clip;
    }, [assetA, currentVrm]);

    const animationClipB = useMemo(() => {
        const clip = remapMixamoAnimationToVrm(currentVrm, assetB);
        clip.name = "Thriller Part 2";
        return clip;
    }, [assetB, currentVrm]);

    const animationClipC = useMemo(() => {
        const clip = remapMixamoAnimationToVrm(currentVrm, assetC);
        clip.name = "Idle";
        return clip;
    }, [assetC, currentVrm]);

    const { actions } = useAnimations(
        [animationClipA, animationClipB, animationClipC],
        currentVrm.scene
    );

    // IK & POSE REFS
    const ikSolvers = useRef({ left: null, right: null });
    const ikTargets = useRef({ left: null, right: null });
    const dummyBones = useRef({ left: {}, right: {} });
    const dummyMeshes = useRef({ left: null, right: null });
    const rawPose3D = useRef(null);

    const restPoseQuats = useRef({});
    useEffect(() => {
        const vrm = userData.vrm;
        if (!vrm) return;

        if (!vrm.scene.userData.isOptimized) {
            try {
                VRMUtils.removeUnnecessaryVertices(scene);
                VRMUtils.combineSkeletons(scene);
                VRMUtils.combineMorphs(vrm);
            } catch (e) {
                console.warn("VRM optimization skipped:", e);
            }
            vrm.scene.userData.isOptimized = true;
        }

        vrm.scene.traverse((obj) => {
            obj.frustumCulled = false;
        });

        const bonesToSave = [
            "leftUpperArm", "leftLowerArm", "leftHand",
            "rightUpperArm", "rightLowerArm", "rightHand"
        ];

        bonesToSave.forEach(boneName => {
            const bone = vrm.humanoid.getNormalizedBoneNode(boneName);
            if (bone) restPoseQuats.current[boneName] = bone.quaternion.clone();
        });

        const setupArmIK = (side, upperName, lowerName, handName) => {
            const vrmUpper = vrm.humanoid.getNormalizedBoneNode(upperName);
            const vrmLower = vrm.humanoid.getNormalizedBoneNode(lowerName);
            const vrmHand = vrm.humanoid.getNormalizedBoneNode(handName);
            if (!vrmUpper || !vrmLower || !vrmHand) return;

            const dShoulder = new Bone();
            const dElbow = new Bone();
            const dWrist = new Bone();
            const dTarget = new Bone();

            dShoulder.position.copy(vrmUpper.position);
            dElbow.position.copy(vrmLower.position);
            dWrist.position.copy(vrmHand.position);

            dShoulder.add(dElbow);
            dElbow.add(dWrist);

            const geo = new BufferGeometry();
            geo.setAttribute('position', new Float32BufferAttribute([0, 0, 0], 3));
            // Add blank skin weights and indices so Three.js SkinnedMesh doesn't crash
            geo.setAttribute('skinIndex', new Float32BufferAttribute([0, 0, 0, 0], 4));
            geo.setAttribute('skinWeight', new Float32BufferAttribute([1, 0, 0, 0], 4));

            const dummyMesh = new SkinnedMesh(geo, undefined);
            dummyMesh.frustumCulled = false; // Prevent projection bounding sphere crashes
            dummyMesh.add(dShoulder);
            dummyMesh.add(dTarget);

            vrm.scene.add(dummyMesh);
            dummyMeshes.current[side] = dummyMesh;

            const skeleton = new Skeleton([dShoulder, dElbow, dWrist, dTarget]);
            dummyMesh.bind(skeleton);

            const iks = [{
                target: 3,
                effector: 2,
                links: [{ index: 1 }, { index: 0 }],
                iteration: 5
            }];

            const solver = new CCDIKSolver(dummyMesh, iks);

            ikSolvers.current[side] = solver;
            ikTargets.current[side] = dTarget;
            dummyBones.current[side] = { shoulder: dShoulder, elbow: dElbow };
        };

        setupArmIK('left', 'leftUpperArm', 'leftLowerArm', 'leftHand');
        setupArmIK('right', 'rightUpperArm', 'rightLowerArm', 'rightHand');

        return () => {
            if (dummyMeshes.current.left) dummyMeshes.current.left.removeFromParent();
            if (dummyMeshes.current.right) dummyMeshes.current.right.removeFromParent();
        };
    }, [scene, userData.vrm]);

    const setResultsCallback = useVideoRecognition((state) => state.setResultsCallback);
    const videoElement = useVideoRecognition((state) => state.videoElement);
    const riggedFace = useRef();
    const riggedPose = useRef();
    const riggedLeftHand = useRef();
    const riggedRightHand = useRef();

    const rawLeftHandData = useRef(null);
    const rawRightHandData = useRef(null);

    const handCalibData = useRef({ leftHand: null, rightHand: null });
    const calibrateFlag = useRef(false);

    const resultsCallback = useCallback(
        (results) => {
            if (!videoElement || !currentVrm) return;

            // Fallback safely to poseLandmarks if poseWorldLandmarks is missing
            if (results.poseWorldLandmarks || results.poseLandmarks) {
                rawPose3D.current = results.poseWorldLandmarks || results.poseLandmarks;
            }

            if (results.faceLandmarks) {
                riggedFace.current = Face.solve(results.faceLandmarks, {
                    runtime: "mediapipe",
                    video: videoElement,
                    imageSize: { width: 640, height: 480 },
                    smoothBlink: false,
                    blinkSettings: [0.25, 0.75],
                });
            }

            if (results.za && results.poseLandmarks) {
                riggedPose.current = Pose.solve(results.za, results.poseLandmarks, {
                    runtime: "mediapipe",
                    video: videoElement,
                });
            }

            if (results.leftHandLandmarks) {
                rawRightHandData.current = {
                    landmarks: results.leftHandLandmarks,
                    isRightHand: true,
                };
                riggedRightHand.current = Hand.solve(results.leftHandLandmarks, "Right");
            }
            if (results.rightHandLandmarks) {
                rawLeftHandData.current = {
                    landmarks: results.rightHandLandmarks,
                    isRightHand: false,
                };
                riggedLeftHand.current = Hand.solve(results.rightHandLandmarks, "Left");
            }
        },
        [videoElement, currentVrm]
    );

    useEffect(() => {
        setResultsCallback(resultsCallback);
    }, [resultsCallback]);

    const calibrateTimer = useRef(null);
    const [calibCountdown, setCalibCountdown] = useState(null);

    const {
        aa, ih, ee, oh, ou,
        blinkLeft, blinkRight,
        angry, sad, happy,
        animation,
        useCustomHandRotation,
    } = useControls("VRM", {
        aa: { value: 0, min: 0, max: 1 },
        ih: { value: 0, min: 0, max: 1 },
        ee: { value: 0, min: 0, max: 1 },
        oh: { value: 0, min: 0, max: 1 },
        ou: { value: 0, min: 0, max: 1 },
        blinkLeft: { value: 0, min: 0, max: 1 },
        blinkRight: { value: 0, min: 0, max: 1 },
        angry: { value: 0, min: 0, max: 1 },
        sad: { value: 0, min: 0, max: 1 },
        happy: { value: 0, min: 0, max: 1 },
        animation: {
            options: ["None", "Idle", "Swing Dancing", "Thriller Part 2"],
            value: "Idle",
        },
        useCustomHandRotation: { value: true, label: "Custom Hand Rot" },
        calibrateHands: button(() => {
            if (calibrateTimer.current) return;
            let seconds = 5;
            setCalibCountdown(seconds);
            const tick = () => {
                seconds--;
                setCalibCountdown(seconds >= 0 ? seconds : null);
                if (seconds >= 0) {
                    calibrateTimer.current = setTimeout(tick, 1000);
                } else {
                    calibrateFlag.current = true;
                    calibrateTimer.current = null;
                }
            };
            tick();
        }),
    });

    useEffect(() => {
        if (animation === "None" || videoElement) return;
        actions[animation]?.play();
        return () => { actions[animation]?.stop(); };
    }, [actions, animation, videoElement]);

    const lerpExpression = (name, value, lerpFactor) => {
        userData.vrm.expressionManager.setValue(
            name,
            lerp(userData.vrm.expressionManager.getValue(name), value, lerpFactor)
        );
    };

    useFrame((_, delta) => {
        if (!userData.vrm) return;
        const vrm = userData.vrm;

        // 1. ARM IK SOLVER (With Elbow Bend Fix)
        if (rawPose3D.current && ikSolvers.current.left && ikSolvers.current.right) {
            const pose3D = rawPose3D.current;

            const updateArmIK = (side, shoulderIdx, wristIdx, upperVrmName, lowerVrmName) => {
                const mpShoulder = pose3D[shoulderIdx];
                const mpWrist = pose3D[wristIdx];

                const vrmUpper = vrm.humanoid.getNormalizedBoneNode(upperVrmName);
                const vrmLower = vrm.humanoid.getNormalizedBoneNode(lowerVrmName);
                const dummyMesh = dummyMeshes.current[side];

                if (!mpShoulder || !mpWrist || !vrmUpper || !vrmLower || !dummyMesh) return;

                const shoulderWorldPos = new Vector3();
                vrmUpper.getWorldPosition(shoulderWorldPos);

                const armReachScale = 1.5;
                const dx = -(mpWrist.x - mpShoulder.x) * armReachScale;
                const dy = -(mpWrist.y - mpShoulder.y) * armReachScale;
                const dz = (mpWrist.z - mpShoulder.z) * armReachScale;

                // Add a slight forward Z-offset so the elbow always knows which way to bend
                const elbowBendHint = 0.15;

                ikTargets.current[side].position.set(
                    shoulderWorldPos.x + dx,
                    shoulderWorldPos.y + dy,
                    shoulderWorldPos.z + dz + elbowBendHint
                );

                dummyMesh.updateMatrixWorld(true);
                ikSolvers.current[side].update();

                const { shoulder: dShoulder, elbow: dElbow } = dummyBones.current[side];

                vrmUpper.quaternion.slerp(dShoulder.quaternion, delta * 15);
                vrmLower.quaternion.slerp(dElbow.quaternion, delta * 15);
            };

            updateArmIK('left', 11, 15, 'leftUpperArm', 'leftLowerArm');
            updateArmIK('right', 12, 16, 'rightUpperArm', 'rightLowerArm');
        }

        // 2. HAND PROCESSING (Fixed Space Wrist & Safe Pinch)
        const processHand = (boneName, lowerArmName, handData) => {
            if (!handData || !handData.landmarks) return;
            const { landmarks, isRightHand } = handData;

            const lowerArmBone = vrm.humanoid.getNormalizedBoneNode(lowerArmName);
            const targetWristQuat = calculateCustomWristRotation(landmarks, isRightHand, lowerArmBone);

            if (targetWristQuat) {
                const wristBone = vrm.humanoid.getNormalizedBoneNode(boneName);
                if (wristBone) {
                    wristBone.quaternion.slerp(targetWristQuat, delta * 15);
                }
            }

            const thumbTip = landmarks[4];
            const indexTip = landmarks[8];
            const tipDistance = Math.hypot(
                thumbTip.x - indexTip.x,
                thumbTip.y - indexTip.y,
                thumbTip.z - indexTip.z
            );

            const thumbDistal = vrm.humanoid.getNormalizedBoneNode(isRightHand ? 'rightThumbDistal' : 'leftThumbDistal');
            const indexDistal = vrm.humanoid.getNormalizedBoneNode(isRightHand ? 'rightIndexDistal' : 'leftIndexDistal');

            if (thumbDistal && indexDistal) {
                if (tipDistance < 0.05) {
                    tmpEuler.set(0, 0, isRightHand ? 0.4 : -0.4);
                    tmpQuat.setFromEuler(tmpEuler);
                    thumbDistal.quaternion.slerp(tmpQuat, delta * 10);

                    tmpEuler.set(0, 0, isRightHand ? -0.4 : 0.4);
                    tmpQuat.setFromEuler(tmpEuler);
                    indexDistal.quaternion.slerp(tmpQuat, delta * 10);
                }
            }
        };

        if (useCustomHandRotation) {
            processHand('rightHand', 'rightLowerArm', rawRightHandData.current);
            processHand('leftHand', 'leftLowerArm', rawLeftHandData.current);
        }

        vrm.update(delta);
    });

    const camera = useThree((state) => state.camera);
    const lookAtTarget = useRef();
    useEffect(() => {
        lookAtTarget.current = new Object3D();
        camera.add(lookAtTarget.current);
    }, [camera]);

    return <primitive object={scene} {...props} />;
};